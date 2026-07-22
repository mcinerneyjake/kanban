import { isStepId, isStepState, type PipelineStep, type StatusId, type StepId, type TicketEvent, type TicketEventsResponse } from '../../shared/constants.js';

// api.events types res.json() as TicketEventsResponse without checking it, so the terminal strip
// validates at the boundary: a malformed payload must render nothing, never throw into the widget
// tree (a render throw there would unmount the live xterm session).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// PipelineStep.state is wider than TicketEvent.state — it carries 'pending' for a step with no event.
function isPipelineStep(value: unknown): value is PipelineStep {
  if (!isRecord(value)) return false;
  const { step, label, state, at } = value;
  return typeof step === 'string' && isStepId(step)
    && typeof label === 'string'
    && typeof state === 'string' && (state === 'pending' || isStepState(state))
    && (at === null || typeof at === 'string');
}

function isTicketEvent(value: unknown): value is TicketEvent {
  if (!isRecord(value)) return false;
  const { ticketId, step, state, at, detail } = value;
  return typeof ticketId === 'string'
    && typeof step === 'string' && isStepId(step)
    && typeof state === 'string' && isStepState(state)
    && typeof at === 'string'
    && (detail === undefined || typeof detail === 'string');
}

export function isTicketEventsResponse(value: unknown): value is TicketEventsResponse {
  if (!isRecord(value)) return false;
  const { ticketId, pipeline, events } = value;
  return typeof ticketId === 'string'
    && Array.isArray(pipeline) && pipeline.every(isPipelineStep)
    && Array.isArray(events) && events.every(isTicketEvent);
}

const isComplete = (state: PipelineStep['state']): boolean => state === 'reached' || state === 'passed';

// pipelineView needs a StatusId, but the terminal's session is only { ticket? } — no status, and
// threading one through App's sessionStorage-persisted session would go stale on reload. The qa/done
// status transitions emit their own milestones (STATUS_STEP), so the event stream carries it already.
//
// 'todo' (not 'in-progress') is the floor for a pipeline with no milestones at all: pipelineView treats
// in-progress as proof that Started happened even without an event, which would push the frontier onto
// Branch and pulse it on a ticket whose branch doesn't exist yet. Claiming in-progress is only honest
// once some milestone has actually landed.
export function statusFromPipeline(pipeline: PipelineStep[]): StatusId {
  const stateOf = (id: StepId): PipelineStep['state'] =>
    pipeline.find((p) => p.step === id)?.state ?? 'pending';
  if (isComplete(stateOf('done'))) return 'done';
  if (isComplete(stateOf('qa'))) return 'qa';
  return pipeline.some((p) => p.state !== 'pending') ? 'in-progress' : 'todo';
}
