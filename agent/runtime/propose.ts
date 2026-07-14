import { runIntake, mutationKind, type IntakeDeps } from './loop.js';

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

// Run the intake loop in "propose" mode: the agent searches + proposes a
// create/update, but the approval gate CAPTURES the first mutating action and
// declines it — nothing is written. The caller approves + applies it later via
// the normal create/update flow.
export async function proposeIntake(report: string, deps: Omit<IntakeDeps, 'approve'>): Promise<ProposeResult> {
  let proposal: IntakeProposal | null = null;
  const result = await runIntake(report, {
    ...deps,
    approve: (name, args) => {
      // Capture only the first legitimate create/update as the proposal — ignore
      // any other gated tool (e.g. a prompt-injected delete_ticket, or a junk
      // first call) so the proposal always matches the documented create/update
      // contract. Every gated tool is still declined (return false → no write).
      if (mutationKind(name)) proposal ??= { action: name, args: args ?? {} };
      return false; // capture only — never execute
    },
  });
  return { proposal, summary: result.final, runId: result.runId };
}
