import { TYPES, PRIORITIES, STATUSES, type Ticket } from '../../shared/constants.js';

// CONTENT fields only. Excludes STRUCTURAL fields (project/parent/blockers) whose cross-field invariants live only in the modal's guarded controls — raw-carrying them from the agent would bypass the guards (wipe hidden blocker edges, relink to an archived parent, leave cross-project blockers). tkt-727c5cacdfad.
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

// Keep only values of the right type/enum so a bogus model field can't corrupt the form; the service still validates on write.
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

export function proposalTargetId(proposal: { action: string; args: Record<string, unknown> }): string | null {
  return proposal.action === 'update_ticket' && typeof proposal.args.id === 'string'
    ? proposal.args.id
    : null;
}
