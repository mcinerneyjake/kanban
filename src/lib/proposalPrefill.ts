import { TYPES, PRIORITIES, STATUSES, type Ticket } from '../../shared/constants.js';

// The CONTENT fields an intake agent can safely propose from a free-text report.
// Deliberately excludes the STRUCTURAL fields — project, parent, blockers — which
// carry cross-field invariants enforced only by the modal's guarded controls
// (project re-scopes blockers; parent strips archived targets + guards cycles;
// blockers preserve hidden archived/dangling edges). Raw-carrying those from the
// agent would bypass the guards — silently wiping hidden blocker edges, relinking to
// an archived parent, or leaving cross-project blockers (tkt-727c5cacdfad review).
// The user sets those via the form's own validated controls after drafting.
export type Prefill = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'dueDate' | 'assignee'>>;

function isType(v: unknown): v is Ticket['type'] {
  return typeof v === 'string' && TYPES.some((t) => t === v);
}
function isPriority(v: unknown): v is Ticket['priority'] {
  return typeof v === 'string' && PRIORITIES.some((p) => p === v);
}
function isStatus(v: unknown): v is Ticket['status'] {
  return typeof v === 'string' && STATUSES.some((s) => s.id === v);
}

// Map a model-produced (untyped) proposal's args to the safe content prefill —
// keeping only values of the right type / enum membership, so a bogus field from the
// model can't corrupt the prefilled form. The service still validates on write.
export function proposalToPrefill(args: Record<string, unknown>): Prefill {
  const out: Prefill = {};
  if (typeof args.title === 'string') out.title = args.title;
  if (typeof args.body === 'string') out.body = args.body;
  if (isType(args.type)) out.type = args.type;
  if (isPriority(args.priority)) out.priority = args.priority;
  if (isStatus(args.status)) out.status = args.status;
  if (typeof args.dueDate === 'string' || args.dueDate === null) out.dueDate = args.dueDate;
  if (typeof args.assignee === 'string' || args.assignee === null) out.assignee = args.assignee;
  return out;
}

// The existing ticket an UPDATE proposal targets (to open in edit mode), or null
// for a create.
export function proposalTargetId(proposal: { action: string; args: Record<string, unknown> }): string | null {
  return proposal.action === 'update_ticket' && typeof proposal.args.id === 'string'
    ? proposal.args.id
    : null;
}
