import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTicket, updateTicket, getTicket, deleteTicket, archiveStaleTickets, HttpError } from './tickets.js';
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
