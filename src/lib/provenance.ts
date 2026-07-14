import { type Ticket, type TicketSource } from '../../shared/constants.js';

// Returns source+runId only when BOTH are present: a trusted stamp (agent|assisted) AND a runId (needed to deep-link); either alone isn't a linkable authored write.
export function ticketProvenance(ticket: Pick<Ticket, 'source' | 'runId'>): { source: TicketSource; runId: string } | null {
  return ticket.source && ticket.runId ? { source: ticket.source, runId: ticket.runId } : null;
}
