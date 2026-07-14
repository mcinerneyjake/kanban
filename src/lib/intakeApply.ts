import { proposalToPrefill, proposalTargetId, type Prefill } from './proposalPrefill.js';
import type { TicketFormFields } from './ticketDiff.js';
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

// The parent link to seed the form with: the ticket's parent, but only if it's
// still an active (non-archived) ticket on the board.
function activeParentId(ticket: Ticket | null, allTickets: Ticket[]): string | null {
  const id = ticket?.parent ?? null;
  if (!id) return null;
  const parent = allTickets.find((t) => t.id === id);
  return parent && parent.status !== 'archived' ? id : null;
}

// Build the modal's form fields for an existing ticket (edit) or a blank draft
// (create). An optional `prefill` overlays the agent's proposed values onto the
// prefill-able fields (title/type/priority/status/body).
//
// Pass `prefill` for the editable `form` the user sees; OMIT it for the `baseline`
// the save diffs against. The baseline MUST be the ticket's open-time state — with
// the prefill folded in, `form` and `baseline` are identical, so changedFormFields
// returns {} and an agent-proposed edit is silently dropped (tkt-128ee05af9ba).
export function buildTicketForm(ticket: Ticket | null, allTickets: Ticket[], prefill?: Prefill): TicketFormFields {
  return {
    title: prefill?.title ?? ticket?.title ?? '',
    type: prefill?.type ?? ticket?.type ?? 'task',
    priority: prefill?.priority ?? ticket?.priority ?? 'medium',
    status: prefill?.status ?? ticket?.status ?? 'backlog',
    body: prefill?.body ?? ticket?.body ?? '',
    project: ticket?.project ?? null,
    // Keep the FULL stored set (archived/dangling ids included) — the modal filters
    // archived/dangling for DISPLAY only. Filtering here would silently drop those
    // edges on any unrelated blocker edit, since the save PATCHes the whole array
    // wholesale (tkt-c8b4b6aa948d).
    blockers: ticket?.blockers ?? [],
    parent: activeParentId(ticket, allTickets),
    dueDate: ticket?.dueDate ?? null,
    assignee: ticket?.assignee ?? null,
  };
}

// A blocker edge is "hidden" when its target is archived (closed) or dangling (the
// target ticket was deleted). Hidden edges are never shown as removable chips, so the
// user can't see or intentionally remove them — every place that rewrites the blocker
// set must therefore PRESERVE them, or it silently deletes data (tkt-c8b4b6aa948d).
// ONE predicate, shared by the chip-display filter and blockersForProject, so the two
// can't drift out of sync (a divergence would re-open the data-loss class).
export function isHiddenBlockerEdge(id: string, allTickets: Ticket[]): boolean {
  const blocker = allTickets.find((t) => t.id === id);
  return blocker === undefined || blocker.status === 'archived';
}

// When a ticket is reassigned to `project`, decide which of its current blockers to
// keep. Blockers are project-scoped, so a VISIBLE active blocker from another project
// is dropped — but HIDDEN edges are KEPT (see isHiddenBlockerEdge): the user never saw
// them and can't re-add them, so filtering them out here would silently delete the edge
// — the same wipe, via the project-change trigger.
export function blockersForProject(blockers: string[], allTickets: Ticket[], project: string | null): string[] {
  if (project === null) return blockers;
  return blockers.filter((id) => {
    if (isHiddenBlockerEdge(id, allTickets)) return true;              // hidden — always keep
    return allTickets.find((t) => t.id === id)?.project === project;   // visible active — same-project only
  });
}
