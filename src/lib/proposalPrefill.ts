import { TYPES, PRIORITIES, STATUSES, type Ticket } from '../../shared/constants.js';

export type Prefill = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body'>>;

function isType(v: unknown): v is Ticket['type'] {
  return typeof v === 'string' && TYPES.some((t) => t === v);
}
function isPriority(v: unknown): v is Ticket['priority'] {
  return typeof v === 'string' && PRIORITIES.some((p) => p === v);
}
function isStatus(v: unknown): v is Ticket['status'] {
  return typeof v === 'string' && STATUSES.some((s) => s.id === v);
}

// Map a model-produced (untyped) proposal's args to a safe set of ticket form
// fields — keeping only values of the right type / enum membership, so a bogus
// field from the model can't corrupt the prefilled form.
export function proposalToPrefill(args: Record<string, unknown>): Prefill {
  const out: Prefill = {};
  if (typeof args.title === 'string') out.title = args.title;
  if (typeof args.body === 'string') out.body = args.body;
  if (isType(args.type)) out.type = args.type;
  if (isPriority(args.priority)) out.priority = args.priority;
  if (isStatus(args.status)) out.status = args.status;
  return out;
}

// The existing ticket an UPDATE proposal targets (to open in edit mode), or null
// for a create.
export function proposalTargetId(proposal: { action: string; args: Record<string, unknown> }): string | null {
  return proposal.action === 'update_ticket' && typeof proposal.args.id === 'string'
    ? proposal.args.id
    : null;
}
