import type { Ticket, StatusId } from '../../shared/constants.js';

// Blocker (dependency) relationships. A ticket's `blockers` array holds the ids
// of tickets it is *blocked by*; this module derives the two views the UI needs
// from that single stored edge set.

// A blocker only counts while its target is live work. A blocker that is `done`
// no longer blocks (the work it gated is finished), and an `archived` one is off
// the board entirely — neither should keep a dependent looking blocked.
export function isActiveBlocker(status: StatusId): boolean {
  return status !== 'done' && status !== 'archived';
}

// Per-ticket count of *active* blockers, keyed by ticket id — the number behind
// the ⛔ card badge. Computed over the full ticket list (like computeChildCounts)
// so a blocker hidden by a board filter still counts. A blocker id that resolves
// to no ticket (deleted / dangling) or to a done/archived one is not counted, so
// legacy edges self-heal in the display even before a delete sweep prunes them.
export function computeActiveBlockerCounts(tickets: readonly Ticket[]): Record<string, number> {
  const statusById = new Map<string, StatusId>();
  for (const t of tickets) statusById.set(t.id, t.status);

  const counts: Record<string, number> = {};
  for (const t of tickets) {
    let active = 0;
    for (const id of t.blockers) {
      const status = statusById.get(id);
      if (status !== undefined && isActiveBlocker(status)) active++;
    }
    if (active > 0) counts[t.id] = active;
  }
  return counts;
}

// The reverse edge: the tickets that list `id` among their blockers — i.e. the
// tickets this one *blocks*. Archived dependents are dropped as noise; done ones
// stay (they show the dependency was satisfied). Read-only, derived on demand.
export function ticketsBlockedBy(id: string, tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => t.status !== 'archived' && t.blockers.includes(id));
}
