import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listTickets, listProjects, getTicket, createTicket, updateTicket, deleteTicket, archiveStaleTickets, searchTickets, HttpError } from './tickets.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-test-'));
  process.env.TICKETS_DIR_OVERRIDE = tmpDir;
});

afterAll(async () => {
  delete process.env.TICKETS_DIR_OVERRIDE;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const files = await fs.readdir(tmpDir);
  await Promise.all(
    files.filter((f) => f.endsWith('.md')).map((f) => fs.unlink(path.join(tmpDir, f))),
  );
});

// Awaits a promise expected to reject with HttpError and returns the error.
async function httpError<T>(p: Promise<T>): Promise<HttpError> {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  if (!(err instanceof HttpError)) throw new Error('Expected HttpError');
  return err;
}

// Writes a raw .md file directly into the temp tickets dir.
function makeRaw(title: string, order: number, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    title,
    type: 'task',
    priority: 'medium',
    status: 'backlog',
    order: String(order),
    created: "'2026-01-01T00:00:00.000Z'",
    updated: "'2026-01-01T00:00:00.000Z'",
    ...overrides,
  };
  return ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
}

async function writeRaw(id: string, content: string) {
  await fs.writeFile(path.join(tmpDir, `${id}.md`), content, 'utf8');
}

// ---------------------------------------------------------------------------

describe('path-traversal guard', () => {
  it('rejects ../ paths with 400', async () => {
    const err = await httpError(getTicket('../../../etc/passwd'));
    expect(err.status).toBe(400);
  });

  it('rejects ids with slashes with 400', async () => {
    const err = await httpError(getTicket('tkt-abc/def'));
    expect(err.status).toBe(400);
  });

  it('returns 404 for valid-format but missing id', async () => {
    const err = await httpError(getTicket('tkt-doesnotexist'));
    expect(err.status).toBe(404);
  });
});

describe('createTicket validation', () => {
  it('rejects empty title with 400', async () => {
    const err = await httpError(createTicket({ title: '' }));
    expect(err.status).toBe(400);
  });

  it('rejects whitespace-only title with 400', async () => {
    const err = await httpError(createTicket({ title: '   ' }));
    expect(err.status).toBe(400);
  });

  it('rejects invalid type with 400 mentioning "type"', async () => {
    // @ts-expect-error — testing runtime rejection of an invalid enum value
    const err = await httpError(createTicket({ title: 'T', type: 'invalid' }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('type');
  });

  it('rejects invalid priority with 400 mentioning "priority"', async () => {
    // @ts-expect-error — testing runtime rejection of an invalid enum value
    const err = await httpError(createTicket({ title: 'T', priority: 'invalid' }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('priority');
  });

  it('rejects invalid status with 400 mentioning "status"', async () => {
    // @ts-expect-error — testing runtime rejection of an invalid enum value
    const err = await httpError(createTicket({ title: 'T', status: 'invalid' }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('status');
  });
});

describe('createTicket defaults', () => {
  it('applies type/priority/status defaults when omitted', async () => {
    const t = await createTicket({ title: 'Hello' });
    expect(t.type).toBe('task');
    expect(t.priority).toBe('medium');
    expect(t.status).toBe('backlog');
  });
});

describe('normalize coercion', () => {
  it('falls back to "task" for invalid type enum in raw file', async () => {
    await writeRaw('tkt-badtype', makeRaw('Bad type', 1, { type: 'invalid-enum' }));
    const t = await getTicket('tkt-badtype');
    expect(t.type).toBe('task');
  });

  it('coerces a numeric title (unquoted number in YAML) to empty string', async () => {
    // js-yaml parses `title: 42` as the number 42; asString() must not let it
    // flow through as a non-string value — returns '' as a safe fallback.
    const raw = [
      '---',
      'title: 42',
      'type: task',
      'priority: medium',
      'status: backlog',
      'order: 1',
      "created: '2026-01-01T00:00:00.000Z'",
      "updated: '2026-01-01T00:00:00.000Z'",
      '---',
      '',
    ].join('\n');
    await writeRaw('tkt-numtitle', raw);
    const t = await getTicket('tkt-numtitle');
    expect(typeof t.title).toBe('string');
    expect(t.title).toBe('');
  });

  it('coerces unquoted YAML Date fields to ISO strings', async () => {
    // js-yaml auto-parses unquoted ISO timestamps as Date objects; asString() coerces back
    await writeRaw('tkt-datecoerce', [
      '---',
      'title: Date ticket',
      'type: task',
      'priority: medium',
      'status: backlog',
      'order: 1',
      'created: 2026-01-15T10:00:00.000Z',
      'updated: 2026-01-15T10:00:00.000Z',
      '---',
      '',
    ].join('\n'));
    const t = await getTicket('tkt-datecoerce');
    expect(typeof t.created).toBe('string');
    expect(typeof t.updated).toBe('string');
    expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('order assignment', () => {
  it('assigns order 1 on an empty board', async () => {
    const t = await createTicket({ title: 'First' });
    expect(t.order).toBe(1);
  });

  it('assigns maxOrder + 1 when tickets already exist', async () => {
    await writeRaw('tkt-ord1', makeRaw('A', 3));
    await writeRaw('tkt-ord2', makeRaw('B', 7));
    const t = await createTicket({ title: 'New' });
    expect(t.order).toBe(8);
  });
});

describe('updateTicket', () => {
  it('rejects empty title with 400', async () => {
    const t = await createTicket({ title: 'Original' });
    const err = await httpError(updateTicket(t.id, { title: '' }));
    expect(err.status).toBe(400);
  });

  it('returns 404 for nonexistent id', async () => {
    const err = await httpError(updateTicket('tkt-doesnotexist', { title: 'X' }));
    expect(err.status).toBe(404);
  });

  it('partial patch leaves other fields unchanged', async () => {
    const t = await createTicket({ title: 'Keep me', priority: 'high' });
    const updated = await updateTicket(t.id, { status: 'done' });
    expect(updated.title).toBe('Keep me');
    expect(updated.priority).toBe('high');
    expect(updated.status).toBe('done');
  });

  it('advances the updated timestamp', async () => {
    vi.useFakeTimers();
    try {
      const t = await createTicket({ title: 'Timestamp test' });
      vi.advanceTimersByTime(1000);
      const updated = await updateTicket(t.id, { title: 'Changed' });
      expect(new Date(updated.updated).getTime()).toBeGreaterThan(new Date(t.updated).getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears project by passing null, leaving it set when omitted', async () => {
    const t = await createTicket({ title: 'Has project', project: 'Acme' });
    const cleared = await updateTicket(t.id, { project: null });
    expect(cleared.project).toBeNull();
    // omitting project on a later patch must not resurrect or alter it
    const renamed = await updateTicket(t.id, { title: 'Renamed' });
    expect(renamed.project).toBeNull();
  });

  it('sets then clears parent via null', async () => {
    const t = await createTicket({ title: 'Child', parent: 'tkt-parent' });
    expect(t.parent).toBe('tkt-parent');
    const cleared = await updateTicket(t.id, { parent: null });
    expect(cleared.parent).toBeNull();
  });
});

describe('deleteTicket', () => {
  it('resolves for an existing ticket, then getTicket returns 404', async () => {
    const t = await createTicket({ title: 'To delete' });
    await expect(deleteTicket(t.id)).resolves.toBeUndefined();
    const err = await httpError(getTicket(t.id));
    expect(err.status).toBe(404);
  });

  it('returns 404 for a nonexistent id', async () => {
    const err = await httpError(deleteTicket('tkt-ghost'));
    expect(err.status).toBe(404);
  });
});

describe('listProjects', () => {
  it('returns [] when no tickets have a project', async () => {
    await writeRaw('tkt-np1', makeRaw('No project 1', 1));
    await writeRaw('tkt-np2', makeRaw('No project 2', 2));
    expect(await listProjects()).toEqual([]);
  });

  it('returns unique sorted project names, excluding tickets with null project', async () => {
    await writeRaw('tkt-p1', makeRaw('A', 1, { project: 'zebra' }));
    await writeRaw('tkt-p2', makeRaw('B', 2, { project: 'alpha' }));
    await writeRaw('tkt-p3', makeRaw('C', 3, { project: 'zebra' }));
    await writeRaw('tkt-p4', makeRaw('D', 4));
    expect(await listProjects()).toEqual(['alpha', 'zebra']);
  });

  it('excludes empty-string project values', async () => {
    await writeRaw('tkt-ep', makeRaw('Empty project', 1, { project: "''" }));
    expect(await listProjects()).toEqual([]);
  });
});

describe('listTickets', () => {
  it('returns tickets sorted by order ascending regardless of filename order', async () => {
    await writeRaw('tkt-zzz', makeRaw('C', 30));
    await writeRaw('tkt-aaa', makeRaw('A', 10));
    await writeRaw('tkt-mmm', makeRaw('B', 20));
    const tickets = await listTickets();
    expect(tickets.map((t) => t.order)).toEqual([10, 20, 30]);
  });

  it('ignores non-.md files in the tickets directory', async () => {
    await writeRaw('tkt-real', makeRaw('Real', 1));
    await fs.writeFile(path.join(tmpDir, 'README.txt'), 'not a ticket', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'junk', 'utf8');
    const tickets = await listTickets();
    expect(tickets.map((t) => t.id)).toEqual(['tkt-real']);
  });
});

describe('normalize raw-file coercion (invalid enums + blockers)', () => {
  it('falls back to "medium" for an invalid priority in a raw file', async () => {
    await writeRaw('tkt-badprio', makeRaw('Bad prio', 1, { priority: 'screaming' }));
    expect((await getTicket('tkt-badprio')).priority).toBe('medium');
  });

  it('falls back to "backlog" for an invalid status in a raw file', async () => {
    await writeRaw('tkt-badstat', makeRaw('Bad status', 1, { status: 'limbo' }));
    expect((await getTicket('tkt-badstat')).status).toBe('backlog');
  });

  it('filters out non-string entries from a blockers array', async () => {
    // YAML array with mixed types; normalize keeps only the string members.
    await writeRaw('tkt-blockers', makeRaw('Mixed blockers', 1, {
      blockers: '["tkt-aaa", 42, true, "tkt-bbb"]',
    }));
    expect((await getTicket('tkt-blockers')).blockers).toEqual(['tkt-aaa', 'tkt-bbb']);
  });
});

// Helpers for archiveStaleTickets tests.
// "stale" = updated >3 days ago; "fresh" = updated just now.
const STALE_DATE = "'2026-01-01T00:00:00.000Z'";
const freshDate = () => `'${new Date().toISOString()}'`;

describe('archiveStaleTickets', () => {
  it('returns 0 and changes nothing on an empty board', async () => {
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    expect(await listTickets()).toHaveLength(0);
  });

  it('archives a done ticket whose updated timestamp is older than 3 days', async () => {
    await writeRaw('tkt-stale', makeRaw('Stale done', 1, { status: 'done', updated: STALE_DATE }));
    const count = await archiveStaleTickets();
    expect(count).toBe(1);
    const t = await getTicket('tkt-stale');
    expect(t.status).toBe('archived');
  });

  it('does not archive a done ticket updated within the last 3 days', async () => {
    await writeRaw('tkt-fresh', makeRaw('Fresh done', 1, { status: 'done', updated: freshDate() }));
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    const t = await getTicket('tkt-fresh');
    expect(t.status).toBe('done');
  });

  it('does not archive non-done tickets regardless of age', async () => {
    for (const [id, status] of [
      ['tkt-bl', 'backlog'],
      ['tkt-td', 'todo'],
      ['tkt-ip', 'in-progress'],
      ['tkt-qa', 'qa'],
    ]) {
      await writeRaw(id, makeRaw(status, 1, { status, updated: STALE_DATE }));
    }
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    const tickets = await listTickets();
    expect(tickets.every((t) => t.status !== 'archived')).toBe(true);
  });

  it('does not archive a done ticket with a missing updated field (NaN guard)', async () => {
    // Write a ticket without an `updated` key — normalize() produces '' via asString(),
    // which makes new Date('').getTime() return NaN. The guard must treat NaN as "unknown
    // age" and skip archiving rather than archiving immediately.
    const raw = [
      '---',
      'title: No updated field',
      'type: task',
      'priority: medium',
      'status: done',
      'order: 1',
      "created: '2026-01-01T00:00:00.000Z'",
      '---',
      '',
    ].join('\n');
    await writeRaw('tkt-noupdated', raw);
    const count = await archiveStaleTickets();
    expect(count).toBe(0);
    expect((await getTicket('tkt-noupdated')).status).toBe('done');
  });

  it('only archives the stale done tickets in a mixed board', async () => {
    await writeRaw('tkt-stale1', makeRaw('Stale 1', 1, { status: 'done', updated: STALE_DATE }));
    await writeRaw('tkt-stale2', makeRaw('Stale 2', 2, { status: 'done', updated: STALE_DATE }));
    await writeRaw('tkt-recent', makeRaw('Recent done', 3, { status: 'done', updated: freshDate() }));
    await writeRaw('tkt-active', makeRaw('In progress', 4, { status: 'in-progress', updated: STALE_DATE }));

    const count = await archiveStaleTickets();
    expect(count).toBe(2);

    expect((await getTicket('tkt-stale1')).status).toBe('archived');
    expect((await getTicket('tkt-stale2')).status).toBe('archived');
    expect((await getTicket('tkt-recent')).status).toBe('done');
    expect((await getTicket('tkt-active')).status).toBe('in-progress');
  });
});


describe('searchTickets', () => {
  it('returns tickets whose title matches (case-insensitive)', async () => {
    await writeRaw('tkt-s1', makeRaw('Fix Login Bug', 1));
    await writeRaw('tkt-s2', makeRaw('Add Dashboard', 2));
    const results = await searchTickets('login');
    expect(results.map((t) => t.id)).toContain('tkt-s1');
    expect(results.map((t) => t.id)).not.toContain('tkt-s2');
  });

  it('returns tickets whose body matches (case-insensitive)', async () => {
    await writeRaw('tkt-s3', makeRaw('Refactor auth', 1) + 'The password reset flow is broken\n');
    await writeRaw('tkt-s4', makeRaw('Update docs', 2) + 'Nothing relevant here\n');
    const results = await searchTickets('PASSWORD');
    expect(results.map((t) => t.id)).toContain('tkt-s3');
    expect(results.map((t) => t.id)).not.toContain('tkt-s4');
  });

  it('matches across both title and body in the same result set', async () => {
    await writeRaw('tkt-s5', makeRaw('Search title match', 1));
    await writeRaw('tkt-s6', makeRaw('Unrelated', 2) + 'search body match\n');
    const results = await searchTickets('search');
    const ids = results.map((t) => t.id);
    expect(ids).toContain('tkt-s5');
    expect(ids).toContain('tkt-s6');
  });

  it('returns empty array when no tickets match', async () => {
    await writeRaw('tkt-s7', makeRaw('Unrelated ticket', 1));
    const results = await searchTickets('xyzzy-no-match');
    expect(results).toHaveLength(0);
  });

  it('returns all tickets when the term appears everywhere', async () => {
    await writeRaw('tkt-s8', makeRaw('common word', 1));
    await writeRaw('tkt-s9', makeRaw('another common word', 2));
    const results = await searchTickets('common');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns every ticket for an empty query term (matches all)', async () => {
    await writeRaw('tkt-s10', makeRaw('Anything', 1));
    await writeRaw('tkt-s11', makeRaw('Whatever', 2));
    const results = await searchTickets('');
    expect(results).toHaveLength(2);
  });
});

describe('dueDate field', () => {
  it('persists dueDate when set on createTicket', async () => {
    const t = await createTicket({ title: 'With due date', dueDate: '2026-12-31' });
    expect(t.dueDate).toBe('2026-12-31');
    const loaded = await getTicket(t.id);
    expect(loaded.dueDate).toBe('2026-12-31');
  });

  it('defaults dueDate to null when omitted on createTicket', async () => {
    const t = await createTicket({ title: 'No due date' });
    expect(t.dueDate).toBeNull();
  });

  it('updates dueDate via updateTicket', async () => {
    const t = await createTicket({ title: 'Update due date' });
    const updated = await updateTicket(t.id, { dueDate: '2026-06-30' });
    expect(updated.dueDate).toBe('2026-06-30');
    expect((await getTicket(t.id)).dueDate).toBe('2026-06-30');
  });

  it('clears dueDate by setting null via updateTicket', async () => {
    const t = await createTicket({ title: 'Clear due date', dueDate: '2026-06-30' });
    const updated = await updateTicket(t.id, { dueDate: null });
    expect(updated.dueDate).toBeNull();
  });

  it('leaves dueDate unchanged when not in the patch', async () => {
    const t = await createTicket({ title: 'Preserve due date', dueDate: '2026-09-01' });
    const updated = await updateTicket(t.id, { title: 'Renamed' });
    expect(updated.dueDate).toBe('2026-09-01');
  });
});

describe('assignee field', () => {
  it('persists assignee when set on createTicket', async () => {
    const t = await createTicket({ title: 'Assigned ticket', assignee: 'Alice' });
    expect(t.assignee).toBe('Alice');
    expect((await getTicket(t.id)).assignee).toBe('Alice');
  });

  it('defaults assignee to null when omitted on createTicket', async () => {
    const t = await createTicket({ title: 'Unassigned ticket' });
    expect(t.assignee).toBeNull();
  });

  it('updates assignee via updateTicket', async () => {
    const t = await createTicket({ title: 'Reassign me' });
    const updated = await updateTicket(t.id, { assignee: 'Bob' });
    expect(updated.assignee).toBe('Bob');
    expect((await getTicket(t.id)).assignee).toBe('Bob');
  });

  it('clears assignee by setting null via updateTicket', async () => {
    const t = await createTicket({ title: 'Clear assignee', assignee: 'Alice' });
    const updated = await updateTicket(t.id, { assignee: null });
    expect(updated.assignee).toBeNull();
  });

  it('leaves assignee unchanged when not in the patch', async () => {
    const t = await createTicket({ title: 'Preserve assignee', assignee: 'Alice' });
    const updated = await updateTicket(t.id, { title: 'Renamed' });
    expect(updated.assignee).toBe('Alice');
  });
});
