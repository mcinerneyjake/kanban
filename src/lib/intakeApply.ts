import { proposalToPrefill, proposalTargetId, type Prefill } from './proposalPrefill.js';
import type { TicketFormFields } from './ticketDiff.js';
import { CREATE_STATUS_IDS, type Ticket } from '../../shared/constants.js';

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
  | { mode: 'update'; target: Ticket; prefill: Prefill }
  | { mode: 'not-found'; targetId: string | null; prefill: Prefill };

// A prefill destined for the CREATE form: drop a status the create path rejects — only
// `qa` among the board statuses (CREATE_STATUS_IDS is the board columns minus qa; the
// off-board `archived` can't be proposed as a create status either) — so createTicket
// defaults it instead of 400ing (tkt-727c5cacdfad). Update targets keep the full status
// — updateTicket accepts every status.
function createSafePrefill(prefill: Prefill): Prefill {
  if (prefill.status === undefined || CREATE_STATUS_IDS.includes(prefill.status)) return prefill;
  const clamped: Prefill = { ...prefill };
  delete clamped.status;
  return clamped;
}

// Decide create-vs-update for a captured intake proposal and project its args to
// the safe form prefill. Extracted from TicketModal.draft() so the decision is
// unit-testable against the SAME code the modal runs — not a reimplementation.
//
// Routed on the ACTION, not just the id: an `update_ticket` proposal MUST resolve
// to a real, loaded ticket. A missing / blank / unloaded id is 'not-found' — never
// a create, which would silently draft a DUPLICATE of the ticket the agent meant to
// update (tkt-1dfa61b8830e). The prefill rides along so the caller can offer to draft
// it as a new ticket without losing the agent's content; a create-bound prefill is
// status-clamped (createSafePrefill) so that draft can't 400.
export function resolveProposalPlan(proposal: CapturedProposal, allTickets: Ticket[]): IntakePlan {
  const prefill = proposalToPrefill(proposal.args);
  if (proposal.action !== 'update_ticket') return { mode: 'create', prefill: createSafePrefill(prefill) };
  const targetId = proposalTargetId(proposal) || null; // '' (blank id) collapses to null
  const target = targetId !== null ? allTickets.find((t) => t.id === targetId) : undefined;
  if (target) return { mode: 'update', target, prefill };
  return { mode: 'not-found', targetId, prefill: createSafePrefill(prefill) };
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
// (create). An optional `prefill` overlays the agent's proposed CONTENT fields
// (title/type/priority/status/body/dueDate/assignee). The structural fields
// (project/blockers/parent) stay ticket-derived — the prefill can't carry them
// (proposalPrefill), so their guards can't be bypassed.
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
    // dueDate/assignee overlay the agent's proposal (explicit undefined check so a
    // proposed null clears the field). project/blockers/parent are STRUCTURAL — the
    // prefill can't carry them (proposalPrefill), so they stay ticket-derived and their
    // guards (project-scoping, hidden-edge preservation tkt-c8b4b6aa948d, archived-parent
    // strip) can't be bypassed.
    dueDate: prefill?.dueDate !== undefined ? prefill.dueDate : (ticket?.dueDate ?? null),
    assignee: prefill?.assignee !== undefined ? prefill.assignee : (ticket?.assignee ?? null),
    project: ticket?.project ?? null,
    blockers: ticket?.blockers ?? [],
    parent: activeParentId(ticket, allTickets),
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
