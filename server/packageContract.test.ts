import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTicket, updateTicket, getTicket, deleteTicket, archiveStaleTickets, HttpError } from './tickets.js';
import { readEvents } from './events.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

// Contract tests for the PINNED ticket-workflow build, driven through kanban's shim.
//
// Not a copy of the package's unit suite (tkt-6aa717c1c9ec deleted those). That suite runs
// upstream, against upstream SOURCE at upstream HEAD — never against the tag package.json pins,
// and the published tarball ships no tests. So without this file a dep bump to a build that
// regressed any behaviour below would land with typecheck/lint/coverage fully green.
//
// Scope is deliberately narrow: only behaviours that (a) kanban relies on and (b) no surviving
// kanban test asserts. server/index.test.ts MOCKS archiveStaleTickets, so its real staleness
// rule is otherwise unasserted here.

const dirs = setupTempTicketDirs('pkg-contract');

const STALE = "'2026-01-01T00:00:00.000Z'";

async function writeRaw(id: string, fields: Record<string, string>) {
  const all = {
    title: 'T',
    type: 'task',
    priority: 'medium',
    status: 'backlog',
    order: '1',
    created: STALE,
    updated: STALE,
    ...fields,
  };
  const body = ['---', ...Object.entries(all).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
  await fs.writeFile(path.join(dirs.tickets, `${id}.md`), body, 'utf8');
}

describe('pinned ticket-workflow build: parent-cycle guard', () => {
  it('rejects a ticket as its own parent', async () => {
    const t = await createTicket({ title: 'A' });
    await expect(updateTicket(t.id, { parent: t.id })).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects a descendant as the parent, and does not persist the cycle', async () => {
    const parent = await createTicket({ title: 'P' });
    const child = await createTicket({ title: 'C' });
    await updateTicket(child.id, { parent: parent.id });
    await expect(updateTicket(parent.id, { parent: child.id })).rejects.toBeInstanceOf(HttpError);
    expect((await getTicket(parent.id)).parent).toBeNull();
  });
});

describe('pinned ticket-workflow build: referential cleanup on delete', () => {
  it('prunes the deleted id from other tickets blockers and parent', async () => {
    const target = await createTicket({ title: 'Target' });
    const blocked = await createTicket({ title: 'Blocked' });
    const child = await createTicket({ title: 'Child' });
    await updateTicket(blocked.id, { blockers: [target.id] });
    await updateTicket(child.id, { parent: target.id });

    await deleteTicket(target.id);

    expect((await getTicket(blocked.id)).blockers).toEqual([]);
    expect((await getTicket(child.id)).parent).toBeNull();
  });
});

describe('pinned ticket-workflow build: archiveStaleTickets staleness rule', () => {
  it('archives a done ticket older than the staleness window', async () => {
    await writeRaw('tkt-stale0000', { status: 'done' });
    expect(await archiveStaleTickets()).toBe(1);
    expect((await getTicket('tkt-stale0000')).status).toBe('archived');
  });

  it('leaves a freshly-updated done ticket alone', async () => {
    await writeRaw('tkt-fresh0000', { status: 'done', updated: `'${new Date().toISOString()}'` });
    expect(await archiveStaleTickets()).toBe(0);
    expect((await getTicket('tkt-fresh0000')).status).toBe('done');
  });

  it('never archives a stale ticket that is not done', async () => {
    await writeRaw('tkt-open00000', { status: 'in-progress' });
    expect(await archiveStaleTickets()).toBe(0);
    expect((await getTicket('tkt-open00000')).status).toBe('in-progress');
  });
});

describe('pinned ticket-workflow build: id confinement', () => {
  it('rejects a traversal id rather than reading outside the board', async () => {
    await expect(getTicket('../../etc/passwd')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('pinned ticket-workflow build: appendBody is non-destructive', () => {
  it('appends to the existing body instead of replacing it', async () => {
    const t = await createTicket({ title: 'A', body: 'first' });
    await updateTicket(t.id, { appendBody: 'second' });
    const after = await getTicket(t.id);
    expect(after.body).toContain('first');
    expect(after.body).toContain('second');
  });
});

// readEvents' fail-closed rule (tkt-fc7c6846903d, package v0.9.0) and its lost-line counts
// (tkt-355581f9dab3, v0.10.0). kanban imported both by bumping the pin and asserts neither:
// server/index.test.ts drives the HTTP route, so a regression that restored `catch { return []; }`
// would render an all-pending pipeline for a damaged log with the whole gate green — the fail-open
// shape this repo rejects, arriving through a dependency rather than a diff.
describe('pinned ticket-workflow build: unreadable event logs fail closed', () => {
  const seed = (id: string, lines: string[]) =>
    fs.writeFile(path.join(dirs.events, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  const good = (id: string, step: string) =>
    JSON.stringify({ ticketId: id, step, state: 'passed', at: '2026-07-01T00:00:00.000Z' });

  it('returns [] for a genuinely absent log — only ENOENT may read as "no events"', async () => {
    expect(await readEvents('tkt-noevents01')).toEqual({ events: [], skipped: 0, unrecognized: 0 });
  });

  // skipIf, not an early return: root bypasses the mode bits, and a test that reports PASSED where
  // it never ran is the same fail-open it is here to detect.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws rather than returning [] when the log exists but cannot be read',
    async () => {
      await seed('tkt-noperm01', [good('tkt-noperm01', 'lint')]);
      const file = path.join(dirs.events, 'tkt-noperm01.jsonl');
      await fs.chmod(file, 0o000);
      try {
        const err: unknown = await readEvents('tkt-noperm01').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HttpError);
        if (!(err instanceof HttpError)) throw new Error('expected HttpError');
        expect(err.status).toBe(500);
        // The absolute events dir must not ride along: asyncWrap sends HttpError messages verbatim.
        expect(err.message).not.toContain(dirs.events);
      } finally {
        await fs.chmod(file, 0o644);
      }
    },
  );

  it('counts lost lines, and keeps unknown vocabulary out of that count', async () => {
    await seed('tkt-counts001', [
      'not json at all',
      good('tkt-counts001', 'lint'),
      JSON.stringify({ ticketId: 'tkt-counts001', step: 'deploy', state: 'passed', at: 'x' }),
    ]);
    const { events, skipped, unrecognized } = await readEvents('tkt-counts001');
    expect(events.map((e) => e.step)).toEqual(['lint']);
    expect(skipped).toBe(1);
    expect(unrecognized).toBe(1);
  });

  // The one rule that SUPPRESSES a count, so a regression here is silently permissive.
  it('does not count a torn final line, but does once a later event follows it', async () => {
    await fs.writeFile(path.join(dirs.events, 'tkt-torn00001.jsonl'),
      `${good('tkt-torn00001', 'lint')}\n{"ticketId":"tkt-torn00001","step":"co`, 'utf8');
    expect((await readEvents('tkt-torn00001')).skipped).toBe(0);

    await seed('tkt-torn00002', [
      good('tkt-torn00002', 'lint'),
      '{"ticketId":"tkt-torn00002","step":"co',
      good('tkt-torn00002', 'commit'),
    ]);
    expect((await readEvents('tkt-torn00002')).skipped).toBe(1);
  });
});

// ci.yml's gate runs `npx ticket-workflow audit .` (tkt-9342280b2536, v0.15.0). No other kanban
// test touches the pinned CLI, so a bump to a build that dropped or renamed the subcommand would
// pass every local gate and only fail in CI.
describe('pinned ticket-workflow build: CLI ships the audit subcommand', () => {
  it('usage names audit', () => {
    const bin = path.resolve('node_modules/.bin/ticket-workflow');
    const r = spawnSync(bin, [], { encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).toMatch(/\baudit\b/);
  });
});
