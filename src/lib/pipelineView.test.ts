import { describe, it, expect } from 'vitest';
import { pipelineView } from './pipelineView.js';
import { STEPS, type PipelineStep } from '../../shared/constants.js';

// Build a full canonical pipeline, overriding the given steps' states.
function build(states: Partial<Record<PipelineStep['step'], PipelineStep['state']>>): PipelineStep[] {
  return STEPS.map((s) => ({
    step: s.id,
    label: s.label,
    state: states[s.id] ?? 'pending',
    at: states[s.id] ? '2026-07-01T00:00:00.000Z' : null,
  }));
}

// Display nodes are keyed by group, not raw step: typecheck/lint/test → 'gate'.
const stateOf = (v: ReturnType<typeof pipelineView>, key: string) =>
  v.nodes.find((n) => n.key === key)?.state;
const TOTAL = 8; // started, branch, gate, review, commit, pr_opened, qa, done

describe('pipelineView — grouping, status derivation, review gate', () => {
  it('collapses the gate checks and orders Review right after Gate', () => {
    const v = pipelineView(build({}), 'backlog');
    expect(v.nodes.map((n) => n.key)).toEqual(['started', 'branch', 'gate', 'review', 'commit', 'pr_opened', 'qa', 'done']);
    expect(v.progress.total).toBe(TOTAL);
  });

  it('treats a backlog ticket with no events as not started', () => {
    const v = pipelineView(build({}), 'backlog');
    expect(v.started).toBe(false);
    expect(v.current).toBeNull();
    expect(v.progress.done).toBe(0);
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });

  it('fills the Started node from status alone, even with no `started` event (#2)', () => {
    const v = pipelineView(build({}), 'in-progress'); // no events at all
    expect(stateOf(v, 'started')).toBe('reached'); // status proves it started → green
    expect(v.current).toBe('Branch'); // next milestone
  });

  it('derives the "Implementing…" gap once branch is done and the gate has not started', () => {
    const v = pipelineView(build({ branch: 'passed' }), 'in-progress');
    expect(v.current).toBe('Implementing…');
    expect(stateOf(v, 'gate')).toBe('active');
    expect(v.progress.done).toBe(3); // reach = the active Gate frontier (started, branch, gate)
  });

  it('labels the phase "Gate" once any gate check has landed (partial gate)', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed' }), 'in-progress');
    expect(v.current).toBe('Gate'); // gate started but not complete
    expect(stateOf(v, 'gate')).toBe('active');
    expect(v.progress.done).toBe(3); // reach = the active Gate frontier
  });

  it('awaits Review once the whole gate passes (the manual gate before commit)', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed', lint: 'passed', test: 'passed' }), 'in-progress');
    expect(stateOf(v, 'gate')).toBe('passed');
    expect(stateOf(v, 'review')).toBe('active'); // frontier is Review, awaiting confirmation
    expect(v.current).toBe('Review');
    expect(v.progress.done).toBe(4); // reach = the active Review frontier
  });

  it('advances to Commit once review is confirmed', () => {
    const v = pipelineView(
      build({ branch: 'passed', typecheck: 'passed', lint: 'passed', test: 'passed', review: 'reached' }),
      'in-progress',
    );
    expect(stateOf(v, 'review')).toBe('reached');
    expect(stateOf(v, 'commit')).toBe('active');
    expect(v.current).toBe('Commit');
    expect(v.progress.done).toBe(5); // reach = the active Commit frontier
  });

  it('marks pending nodes before the furthest milestone as skipped (monotonic pipeline)', () => {
    // Gate + Review never registered, but Commit did (e.g. a docs-only ticket:
    // branch + commit, gate skipped, review never clicked).
    const v = pipelineView(build({ branch: 'passed', commit: 'passed' }), 'in-progress');
    expect(stateOf(v, 'gate')).toBe('skipped');
    expect(stateOf(v, 'review')).toBe('skipped');
    expect(stateOf(v, 'commit')).toBe('passed');
    expect(stateOf(v, 'pr_opened')).toBe('active'); // frontier is past commit
    // nodes AFTER the frontier stay pending, not skipped
    expect(stateOf(v, 'qa')).toBe('pending');
    expect(stateOf(v, 'done')).toBe('pending');
    // progress = furthest reach (the active PR frontier), running THROUGH the
    // skipped gate/review on the green line: started…pr = 6 of 8
    expect(v.progress.done).toBe(6);
  });

  it('stalls the Gate node and names the failing check when one fails', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed', lint: 'failed' }), 'in-progress');
    expect(v.failed).toBe(true);
    expect(stateOf(v, 'gate')).toBe('failed');
    expect(v.current).toBe('Lint failed'); // the specific sub-check, not just "Gate"
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });

  it('shows a fully completed pipeline with no active node when done', () => {
    const all: Partial<Record<PipelineStep['step'], PipelineStep['state']>> = {};
    for (const s of STEPS) all[s.id] = s.id === 'review' ? 'reached' : 'passed';
    const v = pipelineView(build(all), 'done');
    expect(v.current).toBeNull();
    expect(v.progress).toEqual({ done: TOTAL, total: TOTAL });
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });

  it('marks no active node or current label outside in-progress (qa)', () => {
    const v = pipelineView(build({ branch: 'passed' }), 'qa');
    expect(v.started).toBe(true);
    expect(stateOf(v, 'qa')).toBe('reached'); // status-derived
    expect(v.current).toBeNull();
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });
});
