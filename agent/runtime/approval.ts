// Approval-prompt helpers, extracted from the CLI so the fail-safe EOF behaviour is unit-testable without real stdin (importing index.ts would run the CLI's top-level code).

// "y" / "yes" (case-insensitive, trimmed) approves; everything else declines.
export function isApproval(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

// Closed stdin (EOF / non-interactive) rejects → default to DECLINE (fail-safe, not fail-open) instead of crashing.
export async function askApproval(ask: () => Promise<string>): Promise<boolean> {
  try {
    return isApproval(await ask());
  } catch {
    return false;
  }
}
