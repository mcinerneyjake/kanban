import type { Ticket } from '../../shared/constants.js';
import type { FilterState } from '../components/FilterPopover.js';

// ONE filter predicate for both the board and the Archive lane, so their filtering can't drift
// (tkt-d7919e9f1e9b). Status is intentionally NOT filtered here — callers pre-split archived vs
// active tickets and pass the set they want narrowed. `sort` is display-only and ignored here.
export function matchesFilter(ticket: Ticket, filter: FilterState, searchTerm: string): boolean {
  if (filter.types.length > 0 && !filter.types.includes(ticket.type)) return false;
  if (filter.priority && ticket.priority !== filter.priority) return false;
  if (filter.project && ticket.project !== filter.project) return false;
  if (filter.assignee && ticket.assignee !== filter.assignee) return false;
  if (filter.dateFrom || filter.dateTo) {
    const d = ticket[filter.dateField].slice(0, 10);
    if (filter.dateFrom && d < filter.dateFrom) return false;
    if (filter.dateTo && d > filter.dateTo) return false;
  }
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    if (!ticket.title.toLowerCase().includes(term) && !ticket.body.toLowerCase().includes(term)) return false;
  }
  return true;
}

export function filterTickets(tickets: Ticket[], filter: FilterState, searchTerm: string): Ticket[] {
  return tickets.filter((t) => matchesFilter(t, filter, searchTerm));
}
