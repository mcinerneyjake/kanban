import { proposalToPrefill, proposalTargetId, type Prefill } from './proposalPrefill.js';
import type { Ticket } from '../../shared/constants.js';

// The shape the intake agent returns as its captured proposal — a create/update
// tool call (agent/runtime/propose.ts's IntakeProposal). Declared structurally
// here (not imported) so this board module keeps no build-time dependency on
// `agent/` — the import-boundary guard (server/agentBoundary.test.ts) forbids it.
export interface CapturedProposal {
  action: string;
  args: Record<string, unknown>;
}

// How the intake UI should apply a captured proposal: draft a NEW ticket, or
// update the EXISTING one the proposal targets.
export type IntakePlan =
  | { mode: 'create'; prefill: Prefill }
  | { mode: 'update'; target: Ticket; prefill: Prefill };

// Decide create-vs-update for a captured intake proposal and project its args to
// the safe form prefill. Extracted from TicketModal.draft() so the decision is
// unit-testable against the SAME code the modal runs — not a reimplementation.
//
// KNOWN BUG (E, tkt-1dfa61b8830e): an update_ticket proposal whose id is NOT in
// `allTickets` currently falls through to `mode: 'create'`, silently drafting a
// duplicate instead of updating. This preserves today's behavior; the fix (a
// distinct not-found outcome) lands in that ticket. The regression assertion is
// the `it.fails` case in src/lib/intakeRoundTrip.test.ts.
export function resolveProposalPlan(proposal: CapturedProposal, allTickets: Ticket[]): IntakePlan {
  const prefill = proposalToPrefill(proposal.args);
  const targetId = proposalTargetId(proposal);
  const target = targetId ? allTickets.find((t) => t.id === targetId) : undefined;
  if (target) return { mode: 'update', target, prefill };
  return { mode: 'create', prefill };
}
