import type { Ticket, StatusId } from '../../shared/constants.js';

// A ticket's `blockers` holds ids it is *blocked by*; this derives the UI's two views.

// A blocker only counts while live: done no longer blocks, archived is off the board.
export function isActiveBlocker(status: StatusId): boolean {
  return status !== 'done' && status !== 'archived';
}

// Archived means stale, not resolved: archive_ticket retires from any status, so the edge may point at
// abandoned work (tkt-5753a764e900). Missing targets stay excluded — deleteTicket scrubs those.
export function isStaleBlocker(status: StatusId): boolean {
  return status === 'archived';
}

// Open holders only — a closed ticket's unresolved deps are history, and counting them adds 400+ noisy badges.
const OPEN_STATUSES: readonly StatusId[] = ['backlog', 'todo', 'in-progress', 'qa'];

function countBlockers(
  tickets: readonly Ticket[],
  matches: (status: StatusId) => boolean,
  holderMatches: (status: StatusId) => boolean,
): Record<string, number> {
  const statusById = new Map<string, StatusId>();
  for (const t of tickets) statusById.set(t.id, t.status);

  const counts: Record<string, number> = {};
  for (const t of tickets) {
    if (!holderMatches(t.status)) continue;
    let n = 0;
    for (const id of t.blockers) {
      const status = statusById.get(id);
      if (status !== undefined && matches(status)) n++;
    }
    if (n > 0) counts[t.id] = n;
  }
  return counts;
}

// Over the full list so a filtered-out blocker still counts. Archived targets land in the stale count below.
export function computeActiveBlockerCounts(tickets: readonly Ticket[]): Record<string, number> {
  return countBlockers(tickets, isActiveBlocker, () => true);
}

export function computeStaleBlockerCounts(tickets: readonly Ticket[]): Record<string, number> {
  return countBlockers(tickets, isStaleBlocker, (s) => OPEN_STATUSES.includes(s));
}

// Reverse edge (tickets this one blocks): archived dropped, done kept; read-only.
export function ticketsBlockedBy(id: string, tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => t.status !== 'archived' && t.blockers.includes(id));
}
