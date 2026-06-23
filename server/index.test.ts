import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, msUntilNextSundayEvening, stopArchiveScheduler, scheduleWeeklyArchive } from './index.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-index-test-'));
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
  await fs.writeFile(path.join(tmpDir, `${id}.md`), content, 'utf8');
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
  it('maps HttpError status codes directly (e.g. 400, 404)', async () => {
    // Path-traversal triggers a 400 HttpError from the service layer
    const res = await request(app).get('/api/tickets/..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('does not leak stack traces in the error response body', async () => {
    // Unknown id gives a 404 with only { error: string }, no stack
    const res = await request(app).get('/api/tickets/zzzzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('stack');
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});

// Build a Date for a given day-of-week and hour (local time).
// day: 0=Sun, 1=Mon, ... 6=Sat
function at(day: number, hour: number): Date {
  const d = new Date();
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
  it('returns all tickets when q is absent', async () => {
    await seedTicket('abc111111111', 'First');
    await seedTicket('abc222222222', 'Second');
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

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
