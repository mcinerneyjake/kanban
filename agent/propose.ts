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
      proposal ??= { action: name, args: args ?? {} };
      return false; // capture only — never execute
    },
  });
  return { proposal, summary: result.final };
}
