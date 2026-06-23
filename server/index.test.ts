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

async function seedTicket(id: string, title = 'Test ticket') {
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
  ].join('\n');
  await fs.writeFile(path.join(tmpDir, `${id}.md`), content, 'utf8');
}

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
