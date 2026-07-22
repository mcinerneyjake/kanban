import { describe, it, expect } from 'vitest';
import { isTicketEventsResponse, statusFromPipeline } from './terminalRelay.js';
import { pipelineView } from './pipelineView.js';
import { STEPS, type PipelineStep } from '../../shared/constants.js';

const step = (over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ step: 'commit', label: 'Commit', state: 'passed', at: '2026-07-22T10:00:00.000Z', ...over });

// Untyped twin for the rejection cases — they carry values the PipelineStep type forbids by design,
// so they can't be built through step() (and the lint bans `as` to force them past it).
const rawStep = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ step: 'commit', label: 'Commit', state: 'passed', at: '2026-07-22T10:00:00.000Z', ...over });

const response = (over: Record<string, unknown> = {}) => ({
  ticketId: 'tkt-abc',
  pipeline: [step()],
  events: [{ ticketId: 'tkt-abc', step: 'commit', state: 'passed', at: '2026-07-22T10:00:00.000Z' }],
  ...over,
});

describe('isTicketEventsResponse', () => {
  it('accepts a well-formed payload', () => {
    expect(isTicketEventsResponse(response())).toBe(true);
  });

  it("accepts a pending step with a null timestamp (wider than TicketEvent's state)", () => {
    expect(isTicketEventsResponse(response({ pipeline: [step({ state: 'pending', at: null })] }))).toBe(true);
  });

  it('accepts an optional detail on an event', () => {
    const events = [{ ticketId: 'tkt-abc', step: 'review', state: 'reached', at: '2026-07-22T10:00:00.000Z', detail: 'cleared' }];
    expect(isTicketEventsResponse(response({ events }))).toBe(true);
  });

  it('accepts empty pipeline and events arrays', () => {
    expect(isTicketEventsResponse(response({ pipeline: [], events: [] }))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a non-object', 'nope'],
    ['an array', []],
    ['a missing ticketId', response({ ticketId: undefined })],
    ['a non-string ticketId', response({ ticketId: 7 })],
    ['a missing pipeline', response({ pipeline: undefined })],
    ['a non-array pipeline', response({ pipeline: {} })],
    ['a non-array events', response({ events: {} })],
    ['an unknown step id', response({ pipeline: [rawStep({ step: 'deploy' })] })],
    ['an invalid step state', response({ pipeline: [rawStep({ state: 'exploded' })] })],
    ['a non-string label', response({ pipeline: [rawStep({ label: 12 })] })],
    ['a numeric timestamp', response({ pipeline: [rawStep({ at: 1700000000 })] })],
    ['a null entry in the pipeline', response({ pipeline: [null] })],
    // 'pending' is valid on a PipelineStep but never on a raw event.
    ['a pending event state', response({ events: [{ ticketId: 'tkt-abc', step: 'commit', state: 'pending', at: '2026-07-22T10:00:00.000Z' }] })],
    ['an event missing its timestamp', response({ events: [{ ticketId: 'tkt-abc', step: 'commit', state: 'passed' }] })],
  ])('rejects %s', (_label, value) => {
    expect(isTicketEventsResponse(value)).toBe(false);
  });
});

describe('statusFromPipeline', () => {
  it('reports done once the done step is complete', () => {
    expect(statusFromPipeline([step({ step: 'done', label: 'Done', state: 'reached' })])).toBe('done');
  });

  it('reports qa when qa is complete but done is not', () => {
    const pipeline = [
      step({ step: 'qa', label: 'QA', state: 'reached' }),
      step({ step: 'done', label: 'Done', state: 'pending', at: null }),
    ];
    expect(statusFromPipeline(pipeline)).toBe('qa');
  });

  it('prefers done over qa when both are complete', () => {
    const pipeline = [
      step({ step: 'qa', label: 'QA', state: 'reached' }),
      step({ step: 'done', label: 'Done', state: 'reached' }),
    ];
    expect(statusFromPipeline(pipeline)).toBe('done');
  });

  it('reports in-progress once any milestone has landed', () => {
    expect(statusFromPipeline([step()])).toBe('in-progress');
  });

  // Regression: an 'in-progress' floor made pipelineView imply Started complete on a never-worked
  // ticket, pulsing Branch as the active frontier before any branch existed.
  it('floors to todo when every step is still pending', () => {
    const pipeline = [
      step({ step: 'started', label: 'Started', state: 'pending', at: null }),
      step({ step: 'branch', label: 'Branch', state: 'pending', at: null }),
    ];
    expect(statusFromPipeline(pipeline)).toBe('todo');
  });

  it('floors to todo on an empty pipeline', () => {
    expect(statusFromPipeline([])).toBe('todo');
  });

  it('reports in-progress on a failed milestone (pending is the only not-started state)', () => {
    expect(statusFromPipeline([step({ step: 'typecheck', label: 'Typecheck', state: 'failed' })])).toBe('in-progress');
  });

  it('does not treat a failed terminal step as complete', () => {
    expect(statusFromPipeline([step({ step: 'done', label: 'Done', state: 'failed' })])).toBe('in-progress');
  });
});

// The bug lived in the seam, not either function alone: statusFromPipeline's floor decides whether
// pipelineView treats Started as implicitly complete, which is what moves the active frontier.
describe('statusFromPipeline → pipelineView', () => {
  const allPending = (): PipelineStep[] =>
    STEPS.map((s) => ({ step: s.id, label: s.label, state: 'pending', at: null }));

  it('shows no phase on a never-worked ticket (must not read "Branch")', () => {
    const pipeline = allPending();
    const view = pipelineView(pipeline, statusFromPipeline(pipeline));
    expect(view.started).toBe(false); // the header indicator renders nothing in this state
    expect(view.current).toBeNull();
    expect(view.nodes.some((n) => n.state === 'active')).toBe(false);
  });

  it('reads Branch only once Started has really landed', () => {
    const pipeline = allPending().map((p): PipelineStep =>
      p.step === 'started' ? { ...p, state: 'reached', at: '2026-07-22T10:00:00.000Z' } : p);
    const view = pipelineView(pipeline, statusFromPipeline(pipeline));
    expect(view.started).toBe(true);
    expect(view.current).toBe('Branch');
  });

  it('reads a failed gate rather than the next phase', () => {
    const pipeline = allPending().map((p): PipelineStep => {
      if (p.step === 'started') return { ...p, state: 'reached', at: '2026-07-22T10:00:00.000Z' };
      if (p.step === 'typecheck') return { ...p, state: 'failed', at: '2026-07-22T10:01:00.000Z' };
      return p;
    });
    const view = pipelineView(pipeline, statusFromPipeline(pipeline));
    expect(view.failed).toBe(true);
    expect(view.current).toBe('Typecheck failed');
  });
});
