import { runIntake, type IntakeDeps } from './loop.js';

export interface IntakeProposal {
  /** The proposed tool — 'create_ticket' or 'update_ticket'. */
  action: string;
  /** Proposed ticket fields (create) or { id, ...updates } (update). */
  args: Record<string, unknown>;
}

export interface ProposeResult {
  /** The proposed write, or null if the agent proposed none (e.g. only searched). */
  proposal: IntakeProposal | null;
  summary: string;
  /** The run's id — links the (later) intake-apply write + its economics back here. */
  runId: string;
}

// Deterministic, non-failure summary for a captured proposal. The model's post-capture narration WAS the bug (it observed the decline and reported a *failure*), so the subtitle is synthesized from the proposal itself.
function summarizeProposal(name: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  if (name === 'update_ticket') {
    const id = typeof a.id === 'string' ? a.id : 'an existing ticket';
    const fields = Object.keys(a).filter((k) => k !== 'id');
    const what = fields.length ? ` (${fields.join(', ')})` : '';
    return `Proposed an update to ${id}${what} for your review.`;
  }
  const title = typeof a.title === 'string' ? a.title : 'a new ticket';
  return `Proposed a new ticket "${title}" for your review.`;
}

// Run the intake loop in "propose" mode: the agent searches + proposes, the loop CAPTURES the first mutating action and halts (nothing written, no decline observed). The caller approves + applies the proposal later.
export async function proposeIntake(report: string, deps: Omit<IntakeDeps, 'approve' | 'onCapture'>): Promise<ProposeResult> {
  let proposal: IntakeProposal | null = null;
  const result = await runIntake(report, {
    ...deps,
    // Decline any gated tool that ISN'T the captured proposal — e.g. a prompt-injected delete_ticket — so nothing is ever written.
    approve: () => false,
    // Capture the first create/update and halt; synthesize the summary from the proposal, not the model's post-decline narration.
    onCapture: (name, args) => {
      proposal = { action: name, args: args ?? {} };
      return summarizeProposal(name, args);
    },
  });
  return { proposal, summary: result.final, runId: result.runId };
}
