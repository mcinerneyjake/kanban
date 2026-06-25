import type { Ticket } from '../../shared/constants.js';

// The sub-ticket count shown on a parent card (the `▸/▾ N` badge).
//
// While a parent is still open, *completed* sub-tickets are dropped from its
// count, so the badge reflects the work that remains. Once the parent itself is
// marked `done`, the full original count is restored — the subtree is closed and
// the children's individual states no longer matter, so the badge shows the
// total it was created with.
//
// Computed over the full ticket list (not the filtered view) so the badge always
// reflects the true child set regardless of active board filters.
export function computeChildCounts(tickets: readonly Ticket[]): Record<string, number> {
  const statusById = new Map<string, Ticket['status']>();
  for (const t of tickets) statusById.set(t.id, t.status);

  const counts: Record<string, number> = {};
  for (const t of tickets) {
    if (!t.parent) continue;
    const parentDone = statusById.get(t.parent) === 'done';
    // Open parent: a completed child is omitted. Done parent: count everything.
    if (!parentDone && t.status === 'done') continue;
    counts[t.parent] = (counts[t.parent] ?? 0) + 1;
  }
  return counts;
}
