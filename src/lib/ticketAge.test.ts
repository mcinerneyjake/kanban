import { describe, it, expect } from 'vitest';
import type { StatusId } from '../../shared/constants.js';
import { daysSince, formatAge, staleAge, STALE_AFTER_DAYS } from './ticketAge.js';

const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const MS_PER_DAY = 86_400_000;

const agoIso = (days: number) => new Date(NOW - days * MS_PER_DAY).toISOString();
const ticket = (status: StatusId, updated: string) => ({ status, updated });

describe('daysSince', () => {
  it('floors the elapsed days', () => {
    expect(daysSince(agoIso(21), NOW)).toBe(21);
    expect(daysSince(new Date(NOW - 21.9 * MS_PER_DAY).toISOString(), NOW)).toBe(21);
  });
  it('returns 0 for a timestamp under a day old', () => {
    expect(daysSince(agoIso(0.5), NOW)).toBe(0);
  });
  it('returns null rather than NaN on an unparseable value', () => {
    expect(daysSince('not-a-date', NOW)).toBeNull();
    expect(daysSince('', NOW)).toBeNull();
  });
  it('does not go negative for a future timestamp', () => {
    // Clock skew between writer and viewer shouldn't render "-1d".
    expect(formatAge(daysSince(agoIso(-2), NOW) ?? 0)).toBe('today');
  });
});

describe('formatAge', () => {
  it('reads "today" under a day', () => {
    expect(formatAge(0)).toBe('today');
    expect(formatAge(-3)).toBe('today');
  });
  it('reads days below the two-month mark', () => {
    expect(formatAge(1)).toBe('1d');
    expect(formatAge(59)).toBe('59d');
  });
  it('switches to months at 60 days', () => {
    expect(formatAge(60)).toBe('2mo');
    expect(formatAge(400)).toBe('13mo');
  });
});

describe('staleAge', () => {
  it('badges a ticket untouched for longer than the threshold', () => {
    expect(staleAge(ticket('backlog', agoIso(34)), NOW)).toEqual({ days: 34, label: '34d' });
  });

  it('badges at exactly the threshold and stays quiet one day under', () => {
    expect(staleAge(ticket('backlog', agoIso(STALE_AFTER_DAYS)), NOW)).not.toBeNull();
    expect(staleAge(ticket('backlog', agoIso(STALE_AFTER_DAYS - 1)), NOW)).toBeNull();
  });

  it('stays quiet for a freshly updated ticket', () => {
    expect(staleAge(ticket('todo', agoIso(2)), NOW)).toBeNull();
  });

  it('excludes done and archived even when they are old', () => {
    const old = agoIso(200);
    expect(staleAge(ticket('done', old), NOW)).toBeNull();
    expect(staleAge(ticket('archived', old), NOW)).toBeNull();
    // Control: the same timestamp on an open ticket does badge, so the nulls above
    // prove the status exclusion rather than a threshold that never fires.
    expect(staleAge(ticket('backlog', old), NOW)).not.toBeNull();
  });

  it('badges every open status', () => {
    const open: StatusId[] = ['backlog', 'todo', 'in-progress', 'qa'];
    for (const status of open) {
      expect(staleAge(ticket(status, agoIso(30)), NOW)).not.toBeNull();
    }
  });

  it('renders nothing on an unparseable updated timestamp', () => {
    expect(staleAge(ticket('backlog', 'not-a-date'), NOW)).toBeNull();
  });
});
