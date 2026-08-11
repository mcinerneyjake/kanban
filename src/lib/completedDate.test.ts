// Pinned to a UTC-behind zone: in a UTC runner a local-vs-UTC date bug is INVISIBLE, because the two
// agree. Set before importing anything that touches Date.
process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import { localDateOf, todayLocal, formatCompleted, msUntilNextLocalMidnight } from './completedDate.js';

describe('timezone control', () => {
  // If TZ did not take effect the suite must SAY so — otherwise every assertion below silently
  // degrades to testing UTC against UTC, which passes while the bug is live.
  it('is running in a UTC-behind zone, so local and UTC dates can differ', () => {
    expect(new Date('2026-08-12T01:00:00.000Z').getHours()).not.toBe(1);
    expect(localDateOf('2026-08-12T01:00:00.000Z')).toBe('2026-08-11');
  });
});

describe('localDateOf', () => {
  it('uses the LOCAL calendar day, not the UTC one', () => {
    // 23:30 EDT on Aug 11 is 03:30Z on Aug 12 — a naive .slice(0,10) yields '2026-08-12'.
    expect(localDateOf('2026-08-12T03:30:00.000Z')).toBe('2026-08-11');
    expect('2026-08-12T03:30:00.000Z'.slice(0, 10)).toBe('2026-08-12'); // the bug, for contrast
  });

  it('returns null on an unparseable value rather than a bogus date', () => {
    expect(localDateOf('not-a-date')).toBeNull();
    expect(localDateOf('')).toBeNull();
  });
});

describe('formatCompleted', () => {
  const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
    new Date(y, m - 1, d, h, min).getTime();

  it('reads Today for a completion earlier the same local day', () => {
    expect(formatCompleted(new Date(at(2026, 8, 11, 9)).toISOString(), at(2026, 8, 11, 17))).toBe('Today');
  });

  it('reads Today for a late-evening completion whose UTC date is tomorrow', () => {
    expect(formatCompleted(new Date(at(2026, 8, 11, 23, 30)).toISOString(), at(2026, 8, 11, 23, 45))).toBe('Today');
  });

  it('reads Yesterday across the local midnight boundary', () => {
    expect(formatCompleted(new Date(at(2026, 8, 10, 23, 30)).toISOString(), at(2026, 8, 11, 0, 15))).toBe('Yesterday');
  });

  it('falls back to a short date further back', () => {
    expect(formatCompleted(new Date(at(2026, 8, 9)).toISOString(), at(2026, 8, 11))).toMatch(/Aug\s*9/);
  });

  it('includes the year when it differs', () => {
    expect(formatCompleted(new Date(at(2025, 12, 30)).toISOString(), at(2026, 8, 11))).toMatch(/2025/);
  });

  it('returns null on an unparseable value', () => {
    expect(formatCompleted('nope', at(2026, 8, 11))).toBeNull();
  });

  // The staleness this feature cannot tolerate: the same ticket, the same render, one midnight later.
  it('flips Today to Yesterday when only `now` advances past midnight', () => {
    const iso = new Date(at(2026, 8, 11, 22)).toISOString();
    expect(formatCompleted(iso, at(2026, 8, 11, 23, 59))).toBe('Today');
    expect(formatCompleted(iso, at(2026, 8, 12, 0, 1))).toBe('Yesterday');
  });
});

describe('todayLocal / msUntilNextLocalMidnight', () => {
  it('todayLocal is the local calendar day of `now`', () => {
    expect(todayLocal(new Date(2026, 7, 11, 23, 30).getTime())).toBe('2026-08-11');
  });

  it('counts down to the next local midnight, never zero or negative', () => {
    const now = new Date(2026, 7, 11, 23, 30).getTime();
    expect(msUntilNextLocalMidnight(now)).toBe(30 * 60 * 1000);
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 11, 0, 0, 0, 0).getTime())).toBe(24 * 60 * 60 * 1000);
  });
});
