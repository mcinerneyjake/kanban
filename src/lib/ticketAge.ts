import type { Ticket, StatusId } from '../../shared/constants.js';

// Age is only actionable as a staleness signal, so the badge is threshold-gated rather than
// on every card. Measured 2026-08-07: 7d badges 81% of live cards, 14d 41%, 21d 27%.
export const STALE_AFTER_DAYS = 21;

const MS_PER_DAY = 86_400_000;

// Elapsed days, not calendar days: no DST or timezone edge to get wrong, and "how long has this
// existed" is what the label claims. Null (not NaN) on an unparseable value, mirroring formatIso.
export function daysSince(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / MS_PER_DAY);
}

export function formatAge(days: number): string {
  if (days <= 0) return 'today';
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

// Same exclusion the due-date badge applies: a closed ticket's age is history, not a prompt to act.
function isOpen(status: StatusId): boolean {
  return status !== 'done' && status !== 'archived';
}

type StaleAge = { days: number; label: string }

// The whole card-badge decision, so Card stays a renderer (and so it is testable — coverage is
// scoped to src/lib and there are no component tests).
export function staleAge(ticket: Pick<Ticket, 'status' | 'updated'>, now: number): StaleAge | null {
  if (!isOpen(ticket.status)) return null;
  const days = daysSince(ticket.updated, now);
  if (days === null || days < STALE_AFTER_DAYS) return null;
  return { days, label: formatAge(days) };
}
