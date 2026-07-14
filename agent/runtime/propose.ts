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

// A deterministic, non-failure summary for a captured proposal. In propose mode the
// model never runs to its own summary (the loop halts at capture), and its
// post-capture narration WAS the bug — it observed the decline and reported a
// *failure* — so the UI subtitle is synthesized from the proposal itself. The modal
// renders the full proposed diff alongside this, so a terse line suffices.
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

// Run the intake loop in "propose" mode: the agent searches + proposes a
// create/update, but the loop CAPTURES the first mutating action and halts —
// nothing is written and the model never observes a decline. The caller approves +
// applies the captured proposal later via the normal create/update flow.
export async function proposeIntake(report: string, deps: Omit<IntakeDeps, 'approve' | 'onCapture'>): Promise<ProposeResult> {
  let proposal: IntakeProposal | null = null;
  const result = await runIntake(report, {
    ...deps,
    // Decline any gated tool that ISN'T the captured proposal — e.g. a
    // prompt-injected delete_ticket — so nothing is ever written. (create/update
    // are intercepted by onCapture before they reach this gate.)
    approve: () => false,
    // Capture the first create/update and halt the loop; synthesize the summary
    // from the proposal rather than the model's (post-decline) narration.
    onCapture: (name, args) => {
      proposal = { action: name, args: args ?? {} };
      return summarizeProposal(name, args);
    },
  });
  return { proposal, summary: result.final, runId: result.runId };
}
