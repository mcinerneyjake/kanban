import type { Ticket, StatusId } from '../../shared/constants.js';

// A ticket's `blockers` holds ids it is *blocked by*; this derives the UI's two views.

// A blocker only counts while live: done no longer blocks, archived is off the board.
export function isActiveBlocker(status: StatusId): boolean {
  return status !== 'done' && status !== 'archived';
}

// Over the full list so a filtered-out blocker still counts; deleted/done/archived ids aren't counted (legacy edges self-heal).
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

// Reverse edge (tickets this one blocks): archived dropped, done kept; read-only.
export function ticketsBlockedBy(id: string, tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => t.status !== 'archived' && t.blockers.includes(id));
}
