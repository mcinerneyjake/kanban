// Completion dates are LOCAL-calendar throughout (tkt-17dbc816e247). Events store UTC instants, and
// 14% of real completions fall in UTC 00:00–03:59 — i.e. after 20:00 local, a different day. Slicing
// the ISO string would silently file last night's work under tomorrow.
// `now` is always injected so these stay pure and testable; react-hooks/purity also bans Date.now()
// in render.

const pad = (n: number): string => String(n).padStart(2, '0');

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function utcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function todayLocal(now: number): string {
  return localDate(new Date(now));
}

// A date-only value as it can appear in frontmatter: a bare date, or one a bulk seed promoted to UTC
// midnight. Classified on the TEXT rather than the parsed instant, because those are not the same
// question — `2026-08-11T20:00:00-04:00` is a real evening instant that lands exactly on UTC midnight
// and must not be read as a date.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/;

// A stored stamp is one of two things, and they must not be treated alike (tkt-cb6ee8e7fdd0):
// a real instant, which belongs on its LOCAL day, or a date-only value — 72 live tickets carry one —
// whose UTC date already IS the day it means. Converting those to local time would move every one of
// them back a day.
export function calendarDateOf(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return DATE_ONLY.test(iso) ? utcDate(new Date(t)) : localDate(new Date(t));
}

// Display counterpart of calendarDateOf: same day, rendered in the viewer's locale. Formatting the
// raw instant instead would re-open the gap this ticket closed — the modal would show a date the
// filter no longer matches. Rebuilding the Date from the resolved parts pins it to local noon, so no
// zone or DST shift can move it back across midnight.
export function formatCalendarDate(iso: string): string {
  const date = calendarDateOf(iso);
  if (date === null) return iso;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString();
}

// setDate(-1) rather than subtracting 86_400_000: across a DST boundary a day is not 24 hours.
function yesterdayLocal(now: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

export function formatCompleted(iso: string, now: number): string | null {
  const date = calendarDateOf(iso);
  if (date === null) return null;
  if (date === todayLocal(now)) return 'Today';
  if (date === yesterdayLocal(now)) return 'Yesterday';
  const d = new Date(Date.parse(iso));
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

// Drives the rollover timer so a board left open overnight stops calling yesterday "Today".
// setHours(24,…) lands on the next local midnight and stays correct across DST.
export function msUntilNextLocalMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime() - now;
}
