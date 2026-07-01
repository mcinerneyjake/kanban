// Pure view-model for the ticket tracking UI. Turns the server's reduced
// `pipeline` (latest state per canonical step) plus the ticket status into
// everything the stepper and card indicator render. Kept out of the components
// so the non-trivial bits — the display grouping, the status-derived nodes, the
// derived "Implementing…" gap, the stalled-on-failure behaviour — are testable.

import { STEPS, type PipelineStep, type StepId, type StatusId } from '../../shared/constants.js';

// Display grouping: how catalog steps collapse into stepper nodes. Keeps the
// event stream granular (the timeline still shows typecheck/lint/test
// separately) while the stepper stays uncluttered — the three gate checks
// render as one "Gate" node. `review` is the manual "Ready to commit?" gate.
interface DisplayGroup { key: string; label: string; steps: StepId[] }
const DISPLAY: readonly DisplayGroup[] = [
  { key: 'started', label: 'Started', steps: ['started'] },
  { key: 'branch', label: 'Branch', steps: ['branch'] },
  { key: 'gate', label: 'Gate', steps: ['typecheck', 'lint', 'test'] },
  { key: 'review', label: 'Review', steps: ['review'] },
  { key: 'commit', label: 'Commit', steps: ['commit'] },
  { key: 'pr_opened', label: 'PR', steps: ['pr_opened'] },
  { key: 'qa', label: 'QA', steps: ['qa'] },
  { key: 'done', label: 'Done', steps: ['done'] },
];

// A node's display state. Extends the pipeline states with `active`: the node
// the agent (or the awaited human, e.g. review) is currently working toward,
// only while the ticket is in-progress.
export type NodeState = 'pending' | 'reached' | 'passed' | 'failed' | 'active'

export interface TrackerNode {
  key: string
  label: string
  state: NodeState
  at: string | null
}

export interface TrackerView {
  nodes: TrackerNode[]
  current: string | null // human phase label; only while in-progress
  failed: boolean // a gate failed → the pipeline is stalled there
  started: boolean // past backlog/todo, or any event has arrived
  progress: { done: number; total: number } // completed nodes / total, for a bar
}

const isComplete = (s: NodeState): boolean => s === 'reached' || s === 'passed';

// Status milestones the ticket's status alone proves complete — even if the
// event never landed (e.g. an MCP server predating the emitter). in-progress ⇒
// started; qa ⇒ started+qa; done/archived ⇒ all three.
function statusImplied(status: StatusId): StepId[] {
  switch (status) {
    case 'in-progress': return ['started'];
    case 'qa': return ['started', 'qa'];
    case 'done':
    case 'archived': return ['started', 'qa', 'done'];
    default: return [];
  }
}

function stepLabel(step: StepId): string {
  return STEPS.find((s) => s.id === step)?.label ?? step;
}

export function pipelineView(pipeline: PipelineStep[], status: StatusId): TrackerView {
  // Effective per-step state: the reduced event state, upgraded to complete for
  // any status-implied milestone that hasn't got its own event yet.
  const stepState = new Map<StepId, PipelineStep['state']>();
  const stepAt = new Map<StepId, string | null>();
  for (const p of pipeline) { stepState.set(p.step, p.state); stepAt.set(p.step, p.at); }
  for (const s of statusImplied(status)) {
    if (!isComplete(stepState.get(s) ?? 'pending')) stepState.set(s, 'reached');
  }

  const failedStep = STEPS.find((s) => stepState.get(s.id) === 'failed');
  const failed = failedStep !== undefined;
  const live = status === 'in-progress' && !failed;

  // Aggregate each display group from its member steps.
  const groups = DISPLAY.map((g) => {
    const states = g.steps.map((st) => stepState.get(st) ?? 'pending');
    const groupFailed = states.some((s) => s === 'failed');
    const allComplete = states.every(isComplete);
    const state: NodeState = groupFailed ? 'failed'
      : allComplete ? (states.some((s) => s === 'passed') ? 'passed' : 'reached')
      : 'pending';
    const at = g.steps.reduce<string | null>((acc, st) => {
      const t = stepAt.get(st) ?? null;
      return t && (!acc || t > acc) ? t : acc;
    }, null);
    const started = g.steps.some((st) => isComplete(stepState.get(st) ?? 'pending'));
    return { key: g.key, label: g.label, state, at, started };
  });

  // Frontier = the next incomplete group past the furthest complete one, so a
  // never-emitted early step (a stale `started`) never traps the pulse behind it.
  let lastDoneIdx = -1;
  groups.forEach((g, i) => { if (isComplete(g.state)) lastDoneIdx = i; });
  const activeIdx = live && lastDoneIdx + 1 < groups.length ? lastDoneIdx + 1 : -1;

  const nodes: TrackerNode[] = groups.map((g, i) => ({
    key: g.key,
    label: g.label,
    state: i === activeIdx ? 'active' : g.state,
    at: g.at,
  }));

  const done = groups.filter((g) => isComplete(g.state)).length;
  const started =
    status === 'in-progress' || status === 'qa' || status === 'done' ||
    pipeline.some((p) => p.state !== 'pending');

  return { nodes, current: currentLabel(groups, status, lastDoneIdx, activeIdx, failedStep), failed, started, progress: { done, total: nodes.length } };
}

// The current-phase label. Special case: when the last completed group is
// `branch` and the gate hasn't started, the agent is between milestones writing
// code — the "Implementing…" gap that has no event of its own.
function currentLabel(
  groups: { key: string; label: string; started: boolean }[],
  status: StatusId,
  lastDoneIdx: number,
  activeIdx: number,
  failedStep: { id: StepId } | undefined,
): string | null {
  if (status !== 'in-progress') return null;
  if (failedStep) return `${stepLabel(failedStep.id)} failed`;
  if (activeIdx === -1) return null;
  // status === in-progress guarantees a status-derived `started`, so there is
  // always a completed group before the frontier — prev is defined here.
  const prev = lastDoneIdx >= 0 ? groups[lastDoneIdx] : undefined;
  const active = groups[activeIdx];
  if (prev?.key === 'branch' && active.key === 'gate' && !active.started) return 'Implementing…';
  return active.label;
}
