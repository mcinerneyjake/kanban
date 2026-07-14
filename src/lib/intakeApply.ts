import { proposalToPrefill, proposalTargetId, type Prefill } from './proposalPrefill.js';
import type { TicketFormFields } from './ticketDiff.js';
import { CREATE_STATUS_IDS, type Ticket } from '../../shared/constants.js';

// Declared structurally (not imported) so this board module keeps no build-time dep on agent/ (server/agentBoundary.test.ts forbids it).
export interface CapturedProposal {
  action: string;
  args: Record<string, unknown>;
}

export type IntakePlan =
  | { mode: 'create'; prefill: Prefill }
  | { mode: 'update'; target: Ticket; prefill: Prefill }
  | { mode: 'not-found'; targetId: string | null; prefill: Prefill };

// Drop a status the CREATE path rejects (only qa among board statuses; archived can't be a create status) so createTicket defaults it instead of 400ing (tkt-727c5cacdfad). Update keeps the full status.
function createSafePrefill(prefill: Prefill): Prefill {
  if (prefill.status === undefined || CREATE_STATUS_IDS.includes(prefill.status)) return prefill;
  const clamped: Prefill = { ...prefill };
  delete clamped.status;
  return clamped;
}

// Routed on the ACTION: an update_ticket proposal MUST resolve to a loaded ticket; a missing/blank/unloaded id is 'not-found', never a create (which would draft a DUPLICATE — tkt-1dfa61b8830e). A create-bound prefill is status-clamped (createSafePrefill) so the draft can't 400.
export function resolveProposalPlan(proposal: CapturedProposal, allTickets: Ticket[]): IntakePlan {
  const prefill = proposalToPrefill(proposal.args);
  if (proposal.action !== 'update_ticket') return { mode: 'create', prefill: createSafePrefill(prefill) };
  const targetId = proposalTargetId(proposal) || null; // '' (blank id) collapses to null
  const target = targetId !== null ? allTickets.find((t) => t.id === targetId) : undefined;
  if (target) return { mode: 'update', target, prefill };
  return { mode: 'not-found', targetId, prefill: createSafePrefill(prefill) };
}

// Parent to seed the form with, but only if it's still an active (non-archived) ticket.
function activeParentId(ticket: Ticket | null, allTickets: Ticket[]): string | null {
  const id = ticket?.parent ?? null;
  if (!id) return null;
  const parent = allTickets.find((t) => t.id === id);
  return parent && parent.status !== 'archived' ? id : null;
}

// prefill overlays the agent's CONTENT fields; structural fields (project/blockers/parent) stay ticket-derived so their guards can't be bypassed. Pass prefill for the editable form; OMIT it for the save baseline — folding it in makes form == baseline, so changedFormFields returns {} and an agent edit is silently dropped (tkt-128ee05af9ba).
export function buildTicketForm(ticket: Ticket | null, allTickets: Ticket[], prefill?: Prefill): TicketFormFields {
  return {
    title: prefill?.title ?? ticket?.title ?? '',
    type: prefill?.type ?? ticket?.type ?? 'task',
    priority: prefill?.priority ?? ticket?.priority ?? 'medium',
    status: prefill?.status ?? ticket?.status ?? 'backlog',
    body: prefill?.body ?? ticket?.body ?? '',
    // Explicit-undefined check so a proposed null clears the field; project/blockers/parent stay ticket-derived (guards can't be bypassed — tkt-c8b4b6aa948d).
    dueDate: prefill?.dueDate !== undefined ? prefill.dueDate : (ticket?.dueDate ?? null),
    assignee: prefill?.assignee !== undefined ? prefill.assignee : (ticket?.assignee ?? null),
    project: ticket?.project ?? null,
    blockers: ticket?.blockers ?? [],
    parent: activeParentId(ticket, allTickets),
  };
}

// A blocker edge is "hidden" when its target is archived or dangling (deleted). Never shown as a chip, so every rewrite of the blocker set must PRESERVE it or it silently deletes data (tkt-c8b4b6aa948d). ONE predicate, shared by the chip filter and blockersForProject, so they can't drift.
export function isHiddenBlockerEdge(id: string, allTickets: Ticket[]): boolean {
  const blocker = allTickets.find((t) => t.id === id);
  return blocker === undefined || blocker.status === 'archived';
}

// On reassign to project: drop VISIBLE active blockers from other projects, but KEEP hidden edges (isHiddenBlockerEdge) — filtering them would silently delete an edge the user never saw.
export function blockersForProject(blockers: string[], allTickets: Ticket[], project: string | null): string[] {
  if (project === null) return blockers;
  return blockers.filter((id) => {
    if (isHiddenBlockerEdge(id, allTickets)) return true;              // hidden — always keep
    return allTickets.find((t) => t.id === id)?.project === project;   // visible active — same-project only
  });
}
