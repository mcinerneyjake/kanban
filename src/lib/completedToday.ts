import type { BoardTicket } from '../../shared/constants.js';
import type { FilterState } from '../components/FilterPopover.js';
import { matchesFilter } from './filterTickets.js';
import { localDateOf, todayLocal } from './completedDate.js';

// Backs the Done column's "N today" chip (tkt-17dbc816e247). Returns the tickets rather than a bare
// count so the caller can also tell whether any of them are archived (and expand that lane).
//
// Spans done AND archived: `Archive all` moves every done ticket, so a done-only count would drop to
// zero exactly when the day ends.
//
// The FilterPopover filter applies, but the date range is stripped — that range is what clicking the
// chip APPLIES, so counting with it would make the number answer its own question and read 0 whenever
// another day is selected. The board's search box is not applied either, matching the Archive lane,
// which deliberately ignores it (tkt-d7919e9f1e9b).
export function completedToday(tickets: BoardTicket[], filter: FilterState, now: number): BoardTicket[] {
  const today = todayLocal(now);
  const withoutDateRange: FilterState = { ...filter, dateFrom: '', dateTo: '' };
  return tickets.filter((t) => {
    if (t.status !== 'done' && t.status !== 'archived') return false;
    if (!t.completedAt || localDateOf(t.completedAt) !== today) return false;
    return matchesFilter(t, withoutDateRange, '');
  });
}
