import { type Ticket } from '../../shared/constants.js';

// The runId a ticket's provenance badge should deep-link to, or null when the
// ticket shows no badge. Both halves are required: `source: 'agent'` is the
// trusted authorship stamp (never set for human/CLI/MCP writes), and a `runId`
// is what makes the run log reachable — a stamp with no runId can't deep-link,
// and a runId without the stamp isn't a trusted agent write. Returning the id
// (not a boolean) lets the caller both decide to render the badge and build its
// link from one call.
export function agentRunId(ticket: Pick<Ticket, 'source' | 'runId'>): string | null {
  return ticket.source === 'agent' && ticket.runId ? ticket.runId : null;
}
