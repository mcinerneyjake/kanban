import type { Ticket } from '../../shared/constants.js';

// Sub-ticket count for a parent card. Open parent: completed children dropped (shows remaining). Done parent: full original count. Over the full list, ignoring board filters.
export function computeChildCounts(tickets: readonly Ticket[]): Record<string, number> {
  const statusById = new Map<string, Ticket['status']>();
  for (const t of tickets) statusById.set(t.id, t.status);

  const counts: Record<string, number> = {};
  for (const t of tickets) {
    if (!t.parent) continue;
    const parentDone = statusById.get(t.parent) === 'done';
    if (!parentDone && t.status === 'done') continue;
    counts[t.parent] = (counts[t.parent] ?? 0) + 1;
  }
  return counts;
}
