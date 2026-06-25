// Approval-prompt helpers for the CLI (agent/index.ts). Extracted into their own
// module so the fail-safe EOF behaviour is unit-testable without driving real
// stdin — importing index.ts would run the CLI (it has top-level execution).

// "y" / "yes" (case-insensitive, trimmed) approves; everything else declines.
export function isApproval(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

// Ask for approval. If the input stream is closed (EOF / non-interactive run),
// the prompt rejects — default to DECLINE, fail-safe and consistent with the
// loop's gate, instead of crashing the agent.
export async function askApproval(ask: () => Promise<string>): Promise<boolean> {
  try {
    return isApproval(await ask());
  } catch {
    return false;
  }
}
