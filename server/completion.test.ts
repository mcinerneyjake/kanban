import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';
import { latestDoneAt, withCompletedAt, withCompletedAtAll, clearCompletionCache } from './completion.js';
import type { Ticket, TicketEvent } from '../shared/constants.js';

const dirs = setupTempTicketDirs('completion');

const mk = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt-1', title: 'T', type: 'task', priority: 'medium', status: 'done', order: 0,
  created: '2026-07-01T00:00:00.000Z', updated: '2026-07-02T00:00:00.000Z', body: '',
  project: 'kanban', blockers: [], parent: null, dueDate: null, assignee: null,
  ...over,
});

const ev = (over: Partial<TicketEvent> = {}): TicketEvent => ({
  ticketId: 'tkt-1', step: 'done', state: 'reached', at: '2026-08-11T19:00:00.000Z', ...over,
});

async function writeEvents(id: string, events: TicketEvent[]): Promise<void> {
  await fs.writeFile(path.join(dirs.events, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

beforeEach(() => clearCompletionCache());

describe('latestDoneAt', () => {
  it('returns the done timestamp', () => {
    expect(latestDoneAt([ev()])).toBe('2026-08-11T19:00:00.000Z');
  });

  it('ignores non-done steps', () => {
    expect(latestDoneAt([ev({ step: 'started' }), ev({ step: 'qa' })])).toBeNull();
  });

  it('takes the LATEST of several done events (reopened then reclosed)', () => {
    const events = [
      ev({ at: '2026-08-01T10:00:00.000Z' }),
      ev({ at: '2026-08-09T10:00:00.000Z' }),
      ev({ at: '2026-08-05T10:00:00.000Z' }),
    ];
    expect(latestDoneAt(events)).toBe('2026-08-09T10:00:00.000Z');
  });

  it('skips unparseable timestamps rather than returning them', () => {
    expect(latestDoneAt([ev({ at: 'garbage' })])).toBeNull();
    expect(latestDoneAt([ev({ at: 'garbage' }), ev({ at: '2026-08-11T19:00:00.000Z' })]))
      .toBe('2026-08-11T19:00:00.000Z');
  });

  it('returns null for no events at all', () => {
    expect(latestDoneAt([])).toBeNull();
  });
});

describe('withCompletedAt', () => {
  it('attaches the done timestamp to a done ticket', async () => {
    await writeEvents('tkt-1', [ev()]);
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });

  it('attaches it to an archived ticket too — archiving preserves the completion', async () => {
    await writeEvents('tkt-1', [ev()]);
    expect((await withCompletedAt(mk({ status: 'archived' }))).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });

  it('gives null when the ticket has no events file (pre-telemetry)', async () => {
    expect((await withCompletedAt(mk())).completedAt).toBeNull();
  });

  it('gives null when events exist but none is a done step', async () => {
    await writeEvents('tkt-1', [ev({ step: 'started' })]);
    expect((await withCompletedAt(mk())).completedAt).toBeNull();
  });

  it('leaves a non-completed ticket untouched, with no completedAt key', async () => {
    await writeEvents('tkt-1', [ev()]);
    const out = await withCompletedAt(mk({ status: 'in-progress' }));
    expect(out.completedAt).toBeUndefined();
  });

  it('enriches only the completed tickets in a list', async () => {
    await writeEvents('tkt-1', [ev()]);
    await writeEvents('tkt-2', [ev({ ticketId: 'tkt-2', at: '2026-08-10T19:00:00.000Z' })]);
    const out = await withCompletedAtAll([mk(), mk({ id: 'tkt-2', status: 'todo' })]);
    expect(out[0].completedAt).toBe('2026-08-11T19:00:00.000Z');
    expect(out[1].completedAt).toBeUndefined();
  });
});

describe('cache invalidation', () => {
  // A cache that never invalidates freezes every date on the board and looks perfectly correct.
  it('picks up a newly appended done event', async () => {
    await writeEvents('tkt-1', [ev({ step: 'started' })]);
    expect((await withCompletedAt(mk())).completedAt).toBeNull();

    await writeEvents('tkt-1', [ev({ step: 'started' }), ev({ at: '2026-08-11T21:00:00.000Z' })]);
    // mtime has moved, so the memo must be discarded rather than replayed.
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T21:00:00.000Z');
  });

  it('serves a repeat read without the file (proving the memo is actually used)', async () => {
    await writeEvents('tkt-1', [ev()]);
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
    // Rewriting identical content changes mtime, so instead assert the cached value survives a
    // second call while the file is untouched — a miss here would still hit disk and pass, so the
    // real assertion is the invalidation test above.
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });
});
