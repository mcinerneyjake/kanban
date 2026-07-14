import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, msUntilNextSundayEvening, stopArchiveScheduler, scheduleWeeklyArchive } from './index.js';
// Namespace import so a single service function can be stubbed to throw a
// non-HttpError, exercising the wrap() 500 branch (live ESM binding — index.ts
// reads the same module object vitest spies on).
import * as tickets from './tickets.js';
import { resetIndexCache } from '../agent/retrieval/indexCache.js';
import { appendRun, readRun, type RunRecord } from '../agent/cost/runLog.js';
import { emptyUsage } from '../agent/cost/usage.js';
import * as econ from '../agent/cost/economicsSummary.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

// The PATCH route drives updateTicket, which emits status-milestone telemetry;
// the helper redirects both the tickets and events I/O to isolated temp dirs
// (fixtures below write to dirs.tickets directly).
const dirs = setupTempTicketDirs('kanban-index-test');

async function seedTicket(id: string, title = 'Test ticket', body = '') {
  const content = [
    '---',
    `title: '${title}'`,
    "type: task",
    "priority: medium",
    "status: backlog",
    "order: 1",
    "created: '2026-01-01T00:00:00.000Z'",
    "updated: '2026-01-01T00:00:00.000Z'",
    '---',
    '',
    body,
  ].join('\n');
  await fs.writeFile(path.join(dirs.tickets, `${id}.md`), content, 'utf8');
}

describe('GET /api/tickets', () => {
  it('returns an empty array when no tickets exist', async () => {
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all tickets', async () => {
    await seedTicket('abc123456789', 'First');
    await seedTicket('def123456789', 'Second');
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe('GET /api/dashboard', () => {
  // Seeds a ticket with an explicit project line in its frontmatter.
  async function seedWithProject(id: string, project: string) {
    const content = [
      '---', `title: '${id}'`, 'type: task', 'priority: medium', 'status: todo',
      'order: 1', `project: ${project}`,
      "created: '2026-01-01T00:00:00.000Z'", "updated: '2026-01-01T00:00:00.000Z'", '---', '',
    ].join('\n');
    await fs.writeFile(path.join(dirs.tickets, `${id}.md`), content, 'utf8');
  }

  it('returns an all-zero summary for an empty board', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.project).toBeNull();
    expect(Array.isArray(res.body.byStatus)).toBe(true);
  });

  it('aggregates all tickets when no project is given', async () => {
    await seedTicket('abc123456789', 'First');
    await seedTicket('def123456789', 'Second');
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('scopes the summary to ?project=', async () => {
    await seedWithProject('aaaaaaaaaaaa', 'kanban');
    await seedWithProject('bbbbbbbbbbbb', 'other');
    const res = await request(app).get('/api/dashboard?project=kanban');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.project).toBe('kanban');
  });
});

describe('GET /api/tickets/:id', () => {
  it('returns the ticket when it exists', async () => {
    await seedTicket('abc123456789', 'My ticket');
    const res = await request(app).get('/api/tickets/abc123456789');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'abc123456789', title: 'My ticket' });
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).get('/api/tickets/zzzzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns 400 for an invalid id (path traversal)', async () => {
    const res = await request(app).get('/api/tickets/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tickets', () => {
  it('creates a ticket and returns 201 with the new ticket', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'New ticket', type: 'task', priority: 'medium', status: 'backlog' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'New ticket', type: 'task' });
    expect(typeof res.body.id).toBe('string');
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app).post('/api/tickets').send({ type: 'task' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('Title') });
  });

  it('returns 400 when title is an empty string', async () => {
    const res = await request(app).post('/api/tickets').send({ title: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 (not 500) when title is a non-string', async () => {
    const res = await request(app).post('/api/tickets').send({ title: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('title') });
  });

  it('returns 400 when project is a non-string', async () => {
    const res = await request(app).post('/api/tickets').send({ title: 'A', project: { nested: true } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('project') });
  });

  it('returns 400 when blockers is not an array of strings', async () => {
    const res = await request(app).post('/api/tickets').send({ title: 'A', blockers: 'tkt-x' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('blockers') });
  });

  it('returns 400 when creating with a non-creatable status (qa)', async () => {
    const res = await request(app).post('/api/tickets').send({ title: 'A', status: 'qa' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('status') });
  });

  it('returns 400 when creating with status archived', async () => {
    const res = await request(app).post('/api/tickets').send({ title: 'A', status: 'archived' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/tickets/:id', () => {
  it('updates an existing ticket and returns the updated body', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(app)
      .patch('/api/tickets/abc123456789')
      .send({ title: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'abc123456789', title: 'Updated' });
  });

  it('returns 400 when order is not a number', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(app)
      .patch('/api/tickets/abc123456789')
      .send({ order: 'five' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('order') });
  });

  it('returns 400 (not 500) when title is a non-string', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(app)
      .patch('/api/tickets/abc123456789')
      .send({ title: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('title') });
  });

  it('returns 400 when parent is a non-string (and does not persist it)', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(app)
      .patch('/api/tickets/abc123456789')
      .send({ parent: 99 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('parent') });
  });

  it('returns 400 when assignee is a nested object (data-loss guard)', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(app)
      .patch('/api/tickets/abc123456789')
      .send({ assignee: { name: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('assignee') });
  });

  it('accepts a fractional order (drag-drop midpoint)', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(app)
      .patch('/api/tickets/abc123456789')
      .send({ order: 1.5 });
    expect(res.status).toBe(200);
    expect(res.body.order).toBe(1.5);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .patch('/api/tickets/zzzzzzzzzzzz')
      .send({ title: 'Ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns 400 for an invalid id', async () => {
    const res = await request(app)
      .patch('/api/tickets/..%2Fbad')
      .send({ title: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/tickets/:id', () => {
  it('deletes an existing ticket and returns 204', async () => {
    await seedTicket('abc123456789', 'To delete');
    const res = await request(app).delete('/api/tickets/abc123456789');
    expect(res.status).toBe(204);
    const check = await request(app).get('/api/tickets/abc123456789');
    expect(check.status).toBe(404);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).delete('/api/tickets/zzzzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns 400 for an invalid id', async () => {
    const res = await request(app).delete('/api/tickets/..%2Fbad');
    expect(res.status).toBe(400);
  });
});

describe('wrap error handler', () => {
  // HttpError status mapping (400 for path-traversal) is already asserted
  // per-route (see "returns 400 for an invalid id (path traversal)"); only the
  // stack-leak guarantee is unique to the wrap handler and lives here.
  it('does not leak stack traces in the error response body', async () => {
    // Unknown id gives a 404 with only { error: string }, no stack
    const res = await request(app).get('/api/tickets/zzzzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('stack');
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});

// A fixed non-DST week so the wall-clock bounds below are stable regardless of
// when CI runs. msUntilNextSundayEvening does local setDate/setHours arithmetic;
// seeding `at()` from the real clock (`new Date()`) meant a DST-transition week
// (US fall-back, late Oct) stretched a "day" to 25h and blew past the ± bounds —
// a latent red build. The day-of-week diff math is anchor-independent.
const FIXED_WEEK = new Date('2026-06-15T12:00:00'); // Monday

// Build a Date for a given day-of-week and hour (local time).
// day: 0=Sun, 1=Mon, ... 6=Sat
function at(day: number, hour: number): Date {
  const d = new Date(FIXED_WEEK);
  const diff = (day - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe('msUntilNextSundayEvening', () => {
  it('Sunday before 6 PM — fires the same evening, not next week', () => {
    const now = at(0, 15); // Sunday 3 PM
    const ms = msUntilNextSundayEvening(now);
    // Should be ~3 hours, not ~7 days
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(4 * 60 * 60 * 1000); // < 4 hours
  });

  it('Sunday at exactly 6 PM — schedules next Sunday (already past)', () => {
    const now = at(0, 18); // Sunday 6 PM sharp
    const ms = msUntilNextSundayEvening(now);
    // setHours(18,0,0,0) on the same day gives target === now → 0 ms
    // The || 7 branch kicks in for day===0 after-18 → next Sunday
    expect(ms).toBeGreaterThan(6 * 24 * 60 * 60 * 1000); // > 6 days
    expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000); // ≤ 7 days
  });

  it('Sunday after 6 PM — schedules next Sunday', () => {
    const now = at(0, 20); // Sunday 8 PM
    const ms = msUntilNextSundayEvening(now);
    expect(ms).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);
  });

  it('Monday — schedules 6 days out', () => {
    const now = at(1, 12); // Monday noon
    const ms = msUntilNextSundayEvening(now);
    const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
    expect(ms).toBeGreaterThan(sixDaysMs - 60_000);
    expect(ms).toBeLessThan(sixDaysMs + 6 * 60 * 60 * 1000 + 60_000);
  });

  it('Saturday — schedules 1 day out', () => {
    const now = at(6, 12); // Saturday noon
    const ms = msUntilNextSundayEvening(now);
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(ms).toBeGreaterThan(oneDayMs - 60_000);
    expect(ms).toBeLessThan(oneDayMs + 6 * 60 * 60 * 1000 + 60_000);
  });

  it('always returns a positive delay', () => {
    for (let day = 0; day < 7; day++) {
      for (const hour of [0, 6, 12, 17, 18, 23]) {
        expect(msUntilNextSundayEvening(at(day, hour))).toBeGreaterThan(0);
      }
    }
  });
});

describe('stopArchiveScheduler', () => {
  it('is exported and callable with no timer running without throwing', () => {
    // The scheduler is never started in tests (entry-point guard), so archiveTimer
    // is null. Calling stop should be a safe no-op.
    expect(() => stopArchiveScheduler()).not.toThrow();
  });

  it('is idempotent — calling twice does not throw', () => {
    expect(() => { stopArchiveScheduler(); stopArchiveScheduler(); }).not.toThrow();
  });

  it('calls clearTimeout exactly once when a timer is running, then becomes a no-op', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      scheduleWeeklyArchive();       // populates archiveTimer
      stopArchiveScheduler();        // should call clearTimeout and null the ref
      expect(clearSpy).toHaveBeenCalledOnce();
      stopArchiveScheduler();        // no-op: archiveTimer is now null
      expect(clearSpy).toHaveBeenCalledOnce(); // still exactly once
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('GET /api/tickets?q= (search)', () => {
  // "returns all when q absent" is covered by GET /api/tickets → "returns all
  // tickets"; not restated here.
  it('returns only matching tickets when q is set', async () => {
    await seedTicket('abc333333333', 'Fix login bug');
    await seedTicket('abc444444444', 'Add dashboard');
    const res = await request(app).get('/api/tickets?q=login');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Fix login bug');
  });

  it('search is case-insensitive', async () => {
    await seedTicket('abc555555555', 'Fix Login Bug');
    const res = await request(app).get('/api/tickets?q=LOGIN');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('matches tickets by body content', async () => {
    await seedTicket('abc666666666', 'Unrelated title', 'The password reset flow is broken');
    await seedTicket('abc777777777', 'Another ticket', 'Nothing relevant');
    const res = await request(app).get('/api/tickets?q=password');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('abc666666666');
  });

  it('returns empty array when nothing matches', async () => {
    await seedTicket('abc888888888', 'Some ticket');
    const res = await request(app).get('/api/tickets?q=xyzzy-no-match');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe('GET /api/projects', () => {
  it('returns an empty array when no tickets have a project', async () => {
    await seedTicket('proj11111111', 'No project');
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns unique project names sorted ascending', async () => {
    // seedTicket writes no `project:` key, so inject it via raw frontmatter.
    const raw = (id: string, project: string) =>
      fs.writeFile(
        path.join(dirs.tickets, `${id}.md`),
        [
          '---', `title: '${id}'`, 'type: task', 'priority: medium',
          'status: backlog', 'order: 1', `project: '${project}'`,
          "created: '2026-01-01T00:00:00.000Z'",
          "updated: '2026-01-01T00:00:00.000Z'", '---', '',
        ].join('\n'),
        'utf8',
      );
    await raw('projaaaaaaaa', 'zebra');
    await raw('projbbbbbbbb', 'alpha');
    await raw('projcccccccc', 'zebra');
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['alpha', 'zebra']);
  });
});

describe('POST /api/archive', () => {
  it('returns { archived: 0 } on an empty board', async () => {
    const res = await request(app).post('/api/archive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ archived: 0 });
  });

  it('archives stale done tickets and returns the count', async () => {
    // A done ticket updated >3 days ago is stale; a fresh one is not.
    const write = (id: string, updated: string) =>
      fs.writeFile(
        path.join(dirs.tickets, `${id}.md`),
        [
          '---', `title: '${id}'`, 'type: task', 'priority: medium',
          'status: done', 'order: 1', `updated: '${updated}'`,
          "created: '2026-01-01T00:00:00.000Z'", '---', '',
        ].join('\n'),
        'utf8',
      );
    await write('arcstale1111', '2026-01-01T00:00:00.000Z');
    await write('arcfresh1111', new Date().toISOString());
    const res = await request(app).post('/api/archive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ archived: 1 });

    const stale = await request(app).get('/api/tickets/arcstale1111');
    expect(stale.body.status).toBe('archived');
    const fresh = await request(app).get('/api/tickets/arcfresh1111');
    expect(fresh.body.status).toBe('done');
  });
});

describe('wrap error funnel — 500 branch', () => {
  it('maps an unexpected (non-HttpError) throw to 500 with only { error }', async () => {
    // Stub a service call to throw a plain Error (not HttpError). wrap() must
    // map it to 500, log it, and respond with { error } — never a stack.
    const spy = vi.spyOn(tickets, 'listProjects').mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(500);
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.body).not.toHaveProperty('stack');
      // The raw internal message must not reach the client (it can embed fs paths
      // or other internals); a generic message is returned and detail is logged.
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.error).not.toContain('boom');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('scheduleWeeklyArchive — timer callback fires', () => {
  it('runs the archive sweep when the timer fires, then reschedules', async () => {
    vi.useFakeTimers();
    // Stub the sweep itself (its archiving logic is covered elsewhere). This
    // isolates the scheduler's own contract: fire the callback, then re-arm.
    const sweep = vi.spyOn(tickets, 'archiveStaleTickets').mockResolvedValue(0);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      scheduleWeeklyArchive();          // arms the first timer
      expect(sweep).not.toHaveBeenCalled();
      // Advance past the longest possible delay (≤7 days) to fire the callback,
      // which awaits archiveStaleTickets() and then reschedules.
      await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
      expect(sweep).toHaveBeenCalled();
      // A new timer must have been armed (recursive reschedule); stopping it
      // calls clearTimeout, proving a live timer existed after the fire.
      stopArchiveScheduler();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      sweep.mockRestore();
      clearSpy.mockRestore();
      stopArchiveScheduler();
      vi.useRealTimers();
    }
  });

  it('keeps the scheduler alive when a sweep rejects (error is swallowed)', async () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(tickets, 'archiveStaleTickets').mockRejectedValue(new Error('disk gone'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      scheduleWeeklyArchive();
      await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
      expect(sweep).toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();   // failure logged, not thrown
      stopArchiveScheduler();
      expect(clearSpy).toHaveBeenCalled(); // still rescheduled despite the error
    } finally {
      sweep.mockRestore();
      errSpy.mockRestore();
      clearSpy.mockRestore();
      stopArchiveScheduler();
      vi.useRealTimers();
    }
  });
});

// --- intake search route (embedder stubbed via global fetch) ---

function isEmbedReq(v: unknown): v is { input: string[] } {
  return typeof v === 'object' && v !== null && 'input' in v
    && Array.isArray(v.input) && v.input.every((s) => typeof s === 'string');
}

describe('POST /api/intake/search', () => {
  // "login"-bearing inputs get a vector aligned with a "login" query, so a
  // login report ranks the login ticket first — deterministic, no real model.
  function stubEmbeddings(): void {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const input = isEmbedReq(parsed) ? parsed.input : [];
      const data = input.map((s, i) => ({ index: i, embedding: [s.toLowerCase().includes('login') ? 1 : 0, 1] }));
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }));
  }

  beforeEach(() => { resetIndexCache(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('400 when query is missing', async () => {
    const res = await request(app).post('/api/intake/search').send({});
    expect(res.status).toBe(400);
  });

  it('returns results ranked by semantic similarity, with status', async () => {
    await seedTicket('tkt-aaa', 'Fix login bug');
    await seedTicket('tkt-bbb', 'Add dashboard charts');
    stubEmbeddings();
    const res = await request(app).post('/api/intake/search').send({ query: 'the login screen is broken' });
    expect(res.status).toBe(200);
    expect(res.body.results[0].id).toBe('tkt-aaa');
    expect(res.body.results[0].status).toBe('backlog');
  });

  it('503 when the embeddings runtime is unreachable', async () => {
    await seedTicket('tkt-aaa', 'Fix login bug');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))));
    const res = await request(app).post('/api/intake/search').send({ query: 'x' });
    expect(res.status).toBe(503);
  });

  it('400 when the query is only whitespace', async () => {
    const res = await request(app).post('/api/intake/search').send({ query: '   ' });
    expect(res.status).toBe(400);
  });

  it('respects the limit parameter', async () => {
    await seedTicket('tkt-aaa', 'Fix login bug');
    await seedTicket('tkt-bbb', 'Another login issue');
    await seedTicket('tkt-ccc', 'Add dashboard charts');
    stubEmbeddings();
    const res = await request(app).post('/api/intake/search').send({ query: 'login', limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('returns an empty list for an empty board without calling the runtime', async () => {
    // No tickets seeded and no fetch stub — search short-circuits on an empty
    // index, so this must succeed even with no model running.
    const res = await request(app).post('/api/intake/search').send({ query: 'anything' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

describe('POST /api/intake/propose', () => {
  // Stubs both /embeddings (for the index) and /chat/completions (scripted turns).
  function stubProposeFlow(turns: { content: string | null; tool_calls?: unknown[] }[]): void {
    let chatTurn = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/embeddings')) {
        const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        const inputs = isEmbedReq(parsed) ? parsed.input : [];
        const data = inputs.map((_str, i) => ({ index: i, embedding: [1, 0, 0] }));
        return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      const message = turns[chatTurn] ?? { content: '(end)' };
      chatTurn++;
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }));
  }

  beforeEach(() => { resetIndexCache(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('400 when report is missing', async () => {
    const res = await request(app).post('/api/intake/propose').send({});
    expect(res.status).toBe(400);
  });

  it('returns a captured proposal without writing it', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    stubProposeFlow([
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"login"}' } }] },
      { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"New bug"}' } }] },
      { content: 'Proposed creating a ticket.' },
    ]);
    const res = await request(app).post('/api/intake/propose').send({ report: 'a new bug to add' });
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ action: 'create_ticket', args: { title: 'New bug' } });
    expect((await tickets.listTickets()).some((t) => t.title === 'New bug')).toBe(false);
  });

  it('503 when the runtime is unreachable', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))));
    const res = await request(app).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(503);
  });

  it('400 when the report is only whitespace', async () => {
    const res = await request(app).post('/api/intake/propose').send({ report: '   ' });
    expect(res.status).toBe(400);
  });

  it('503 when the chat model fails even though the embedder is up', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/embeddings')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(new Error('chat down')); // /chat/completions fails
    }));
    const res = await request(app).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/intake/apply', () => {
  let runsDir: string | null = null;
  beforeAll(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-apply-runs-'));
    process.env.RUNS_DIR_OVERRIDE = runsDir;
  });
  afterAll(async () => {
    delete process.env.RUNS_DIR_OVERRIDE;
    if (runsDir) { await fs.rm(runsDir, { recursive: true, force: true }); runsDir = null; }
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Scripts the propose flow (embeddings + chat turns with usage) so a real runId +
  // captured usage land in the server's pending map — the precondition for apply to
  // stamp provenance + meter (provenance is stamped ONLY when the run is recorded).
  function stubProposeFlow(turns: { content: string | null; tool_calls?: unknown[] }[]): void {
    let turn = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/embeddings')) {
        const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        const inputs = isEmbedReq(parsed) ? parsed.input : [];
        return Promise.resolve(new Response(JSON.stringify({ data: inputs.map((_s, i) => ({ index: i, embedding: [1, 0, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      const message = turns[turn] ?? { content: '(end)' };
      turn++;
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }));
  }
  async function proposeRunId(report: string, turns: { content: string | null; tool_calls?: unknown[] }[]): Promise<string> {
    stubProposeFlow(turns);
    const res = await request(app).post('/api/intake/propose').send({ report });
    expect(res.status).toBe(200);
    vi.unstubAllGlobals(); // apply never calls the model
    return res.body.runId;
  }

  // B + A (create): the fix for "the in-app agent shows no badge / no usage" — a
  // proposed→applied create stamps source:'assisted' + runId (badge + run link) AND
  // records the run's economics from the captured usage.
  it('create: stamps assisted + runId and records the run', async () => {
    const runId = await proposeRunId('a metered bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Metered bug"}' } }] },
      { content: 'Proposed.' },
    ]);
    const res = await request(app).post('/api/intake/apply')
      .send({ action: 'create_ticket', runId, args: { title: 'Metered bug' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: 'assisted', runId, title: 'Metered bug' });
    const run = await readRun(runId);
    expect(run?.ticketIds.created).toContain(res.body.id);
    expect(run?.outcome.created).toBe(1);
    expect(run?.usage.totalTokens).toBeGreaterThan(0);
  });

  // Seam fidelity (CLAUDE.md integration-seam rule): drive the FULL content field set
  // through the real propose→apply endpoint and assert every field lands in the
  // persisted ticket == input. Guards the client-args→extractTicketFields→createTicket
  // path against a silent per-field drop that title-only tests would miss.
  it('create: every proposed content field survives the apply boundary (fidelity)', async () => {
    const args = {
      title: 'Full fidelity', body: 'repro steps here', type: 'bug',
      priority: 'high', status: 'todo', assignee: 'Alice', dueDate: '2026-07-20',
    };
    const runId = await proposeRunId('a fully specified bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: JSON.stringify(args) } }] },
      { content: 'Proposed.' },
    ]);
    const res = await request(app).post('/api/intake/apply').send({ action: 'create_ticket', runId, args });
    expect(res.status).toBe(201);
    // source-input == persisted-output across every field the agent proposed.
    expect(res.body).toMatchObject({ ...args, source: 'assisted', runId });
  });

  // Endpoint idempotency (review): a replayed apply with the same runId (a retry after
  // a lost response, or a second tab) returns the same ticket — no duplicate, no
  // double-meter — so the endpoint doesn't rely solely on the modal's in-flight guard.
  it('is idempotent on runId — a replay returns the same ticket, no duplicate', async () => {
    const runId = await proposeRunId('idempotent bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Idem"}' } }] },
      { content: 'Proposed.' },
    ]);
    const first = await request(app).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Idem' } });
    const second = await request(app).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Idem' } });
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect((await tickets.listTickets()).filter((t) => t.title === 'Idem')).toHaveLength(1);
  });

  // Replay after the applied ticket was deleted: the run still applied, so a retry
  // acknowledges (200) instead of surfacing the getTicket 404 — a benign retry mustn't error.
  it('replay after the ticket was deleted → 200 ack, not 404', async () => {
    const runId = await proposeRunId('deletable bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Deletable"}' } }] },
      { content: 'Proposed.' },
    ]);
    const first = await request(app).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Deletable' } });
    expect(first.status).toBe(201);
    await request(app).delete(`/api/tickets/${first.body.id}`).expect(204);
    const replay = await request(app).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Deletable' } });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: first.body.id, deleted: true });
  });

  // B (update): an assisted update threads the runId (cost link) but leaves authorship
  // (source) — updateTicket sets it once at create, same rule as the CLI agent.
  it('update: threads the runId but does not reassign authorship', async () => {
    await seedTicket('tkt-upd12345678', 'Original'); // human-seeded → source null
    const runId = await proposeRunId('update the login ticket', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_ticket', arguments: '{"id":"tkt-upd12345678","title":"Updated"}' } }] },
      { content: 'Proposed.' },
    ]);
    const res = await request(app).post('/api/intake/apply')
      .send({ action: 'update_ticket', runId, args: { id: 'tkt-upd12345678', title: 'Updated' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'tkt-upd12345678', title: 'Updated', runId });
    expect(res.body.source).toBeNull();
    expect(await readRun(runId)).not.toBeNull();
  });

  it('update with a missing id → 400 (not a silent create)', async () => {
    const res = await request(app).post('/api/intake/apply')
      .send({ action: 'update_ticket', runId: 'run-x', args: { title: 'No id' } });
    expect(res.status).toBe(400);
  });

  // An apply whose runId has no captured usage (server restarted, or evicted before
  // the user saved) falls back to a PLAIN human write — no provenance, so the badge's
  // "View economics" link can't dangle to a missing run.
  it('applies with an unknown runId — plain write (no provenance, no run)', async () => {
    const res = await request(app).post('/api/intake/apply')
      .send({ action: 'create_ticket', runId: 'run-orphan', args: { title: 'Orphan' } });
    expect(res.status).toBe(201);
    expect(res.body.source).toBeNull();
    expect(res.body.runId).toBeNull();
    expect(await readRun('run-orphan')).toBeNull();
  });
});

describe('GET /api/intake/health', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports available:true when the chat runtime responds', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    const res = await request(app).get('/api/intake/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('reports available:false when the runtime is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))));
    const res = await request(app).get('/api/intake/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  it('reports available:false (still 200, never 503) when the runtime errors', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))));
    const res = await request(app).get('/api/intake/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });
});

describe('GET /api/tickets/:id/events', () => {
  it('returns an all-pending pipeline and no events for a never-worked ticket', async () => {
    await seedTicket('tkt-fresh');
    const res = await request(app).get('/api/tickets/tkt-fresh/events');
    expect(res.status).toBe(200);
    expect(res.body.ticketId).toBe('tkt-fresh');
    expect(res.body.events).toEqual([]);
    expect(res.body.pipeline.every((p: { state: string }) => p.state === 'pending')).toBe(true);
  });

  it('reflects a status transition emitted via the PATCH route', async () => {
    await seedTicket('tkt-work', 'Work', '');
    const patch = await request(app).patch('/api/tickets/tkt-work').send({ status: 'in-progress' });
    expect(patch.status).toBe(200);
    const res = await request(app).get('/api/tickets/tkt-work/events');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    const started = res.body.pipeline.find((p: { step: string }) => p.step === 'started');
    expect(started.state).toBe('reached');
  });

  it('rejects an id that fails the path-traversal guard with 400', async () => {
    const res = await request(app).get('/api/tickets/bad.id/events');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tickets/:id/review', () => {
  const reviewState = (body: { pipeline: { step: string; state: string }[] }) =>
    body.pipeline.find((p) => p.step === 'review')?.state;

  it('marks review reached and returns the updated pipeline', async () => {
    await seedTicket('tkt-rev');
    const res = await request(app).post('/api/tickets/tkt-rev/review').send({ reviewed: true });
    expect(res.status).toBe(200);
    expect(reviewState(res.body)).toBe('reached');
  });

  it('un-reviews with { reviewed: false }, reverting review to pending', async () => {
    await seedTicket('tkt-rev');
    await request(app).post('/api/tickets/tkt-rev/review').send({ reviewed: true });
    const res = await request(app).post('/api/tickets/tkt-rev/review').send({ reviewed: false });
    expect(res.status).toBe(200);
    expect(reviewState(res.body)).toBe('pending');
    // both actions are retained in the append-only log
    expect(res.body.events.filter((e: { step: string }) => e.step === 'review')).toHaveLength(2);
  });

  it('defaults to reviewed when no body is sent', async () => {
    await seedTicket('tkt-rev');
    const res = await request(app).post('/api/tickets/tkt-rev/review');
    expect(res.status).toBe(200);
    expect(reviewState(res.body)).toBe('reached');
  });

  it('rejects an invalid id with 400', async () => {
    const res = await request(app).post('/api/tickets/bad.id/review').send({ reviewed: true });
    expect(res.status).toBe(400);
  });

  it('rejects a well-formed id for a nonexistent ticket with 404 and writes no event file', async () => {
    const res = await request(app).post('/api/tickets/tkt-ghost99999999/review').send({ reviewed: true });
    expect(res.status).toBe(404);
    // the orphan events/<id>.jsonl must never have been created
    const files = await fs.readdir(dirs.events);
    expect(files.some((f) => f.includes('tkt-ghost99999999'))).toBe(false);
  });
});

describe('malformed JSON body', () => {
  it('returns a 400 { error } on the JSON contract, not the default HTML error page', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .set('Content-Type', 'application/json')
      .send('{ "title": '); // truncated → express.json throws a SyntaxError
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/economics', () => {
  let runsDir: string;
  beforeAll(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-index-test-runs-'));
    process.env.RUNS_DIR_OVERRIDE = runsDir;
  });
  afterAll(async () => {
    delete process.env.RUNS_DIR_OVERRIDE;
    await fs.rm(runsDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await fs.rm(path.join(runsDir, 'runs.jsonl'), { force: true });
  });

  const rec = (runId: string, at: string): RunRecord => ({
    runId, at, model: 'test', usage: emptyUsage(),
    outcome: { created: 1, updated: 0, declined: 0, noProposal: false, errored: false },
    reviewMs: 0,
    cost: {
      measured: [], externalities: [], headline: [{ label: 'cost per accepted ticket', amount: 0.02, unit: 'USD', kind: 'assumed' }],
      assumed: [{ label: 'total run cost', amount: 0.02, unit: 'USD', kind: 'assumed' }],
    },
    ticketIds: { created: ['tkt-x'], updated: [] },
  });

  it('returns an aggregate summary over the run log', async () => {
    await appendRun(rec('run-1', '2026-07-01T10:00:00.000Z'));
    await appendRun(rec('run-2', '2026-07-02T10:00:00.000Z'));
    const res = await request(app).get('/api/economics');
    expect(res.status).toBe(200);
    expect(res.body.runs).toBe(2);
    expect(res.body.totals.acceptedTickets).toBe(2);
    expect(res.body.timeSeries).toHaveLength(2);
  });

  it('returns zeros for an empty run log', async () => {
    const res = await request(app).get('/api/economics');
    expect(res.status).toBe(200);
    expect(res.body.runs).toBe(0);
  });

  it('filters by ?from/?to (bare dates → inclusive day bounds)', async () => {
    await appendRun(rec('run-1', '2026-07-01T10:00:00.000Z'));
    await appendRun(rec('run-2', '2026-07-05T10:00:00.000Z'));
    const res = await request(app).get('/api/economics?from=2026-07-04&to=2026-07-06');
    expect(res.body.runs).toBe(1);
  });

  it('returns a single run for ?runId=', async () => {
    await appendRun(rec('run-1', '2026-07-01T10:00:00.000Z'));
    await appendRun(rec('run-2', '2026-07-02T10:00:00.000Z'));
    const res = await request(app).get('/api/economics?runId=run-2');
    expect(res.status).toBe(200);
    expect(res.body.runs).toBe(1);
  });

  it('enriches the single-run payload with identity + authored ticket ids', async () => {
    await appendRun(rec('run-2', '2026-07-02T10:00:00.000Z'));
    const res = await request(app).get('/api/economics?runId=run-2');
    expect(res.status).toBe(200);
    // The aggregate rollup drops these; the detail payload carries them so the
    // deep-link view can name the run and link back to its tickets.
    expect(res.body.runId).toBe('run-2');
    expect(res.body.model).toBe('test');
    expect(res.body.at).toBe('2026-07-02T10:00:00.000Z');
    expect(res.body.ticketIds).toEqual({ created: ['tkt-x'], updated: [] });
  });

  it('404s for an unknown runId', async () => {
    const res = await request(app).get('/api/economics?runId=nope');
    expect(res.status).toBe(404);
  });

  it('maps a non-HttpError from the service to 500 (wrap)', async () => {
    const spy = vi.spyOn(econ, 'summarizeEconomicsFromLog').mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/economics');
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});
