// Completion dates are LOCAL-calendar throughout (tkt-17dbc816e247). Events store UTC instants, and
// 14% of real completions fall in UTC 00:00–03:59 — i.e. after 20:00 local, a different day. Slicing
// the ISO string would silently file last night's work under tomorrow.
// `now` is always injected so these stay pure and testable; react-hooks/purity also bans Date.now()
// in render.

function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localDateOf(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : localDate(new Date(t));
}

export function todayLocal(now: number): string {
  return localDate(new Date(now));
}

// setDate(-1) rather than subtracting 86_400_000: across a DST boundary a day is not 24 hours.
function yesterdayLocal(now: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

export function formatCompleted(iso: string, now: number): string | null {
  const date = localDateOf(iso);
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
