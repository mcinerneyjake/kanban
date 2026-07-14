import { type Ticket, type TicketSource } from '../../shared/constants.js';

// The provenance a ticket's badge should show — the writer's source + the runId to
// deep-link — or null when it shows none. Both halves are required: a trusted source
// stamp (agent|assisted, never a plain human/CLI/MCP write) AND a runId (what makes
// the run log reachable). A stamp with no runId can't deep-link; a runId without the
// stamp isn't a trusted authored write. Returning source+runId lets the caller both
// decide to render the badge (and which variant) and build its economics link.
export function ticketProvenance(ticket: Pick<Ticket, 'source' | 'runId'>): { source: TicketSource; runId: string } | null {
  return ticket.source && ticket.runId ? { source: ticket.source, runId: ticket.runId } : null;
}
