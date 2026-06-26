// Shared per-run accounting for runtime calls (chat + embeddings): token usage
// when the runtime reports it, plus active-compute time — the summed duration of
// the model calls, NOT run wall-clock (which includes retrieval I/O and the
// human approval-gate pause, and would overstate energy downstream).

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Total runtime calls timed. */
  calls: number;
  /** Calls that returned a usage block — tokens are "available" iff this is > 0. */
  reportedCalls: number;
  /** Summed active-compute time across calls, in milliseconds. */
  activeMs: number;
}

export function emptyUsage(): RunUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, reportedCalls: 0, activeMs: 0 };
}

export interface CallTokens { prompt: number; completion: number; total: number }

// Accumulates timed runtime calls. Every call records its duration; token
// figures are added only when the runtime actually reported them.
export class UsageMeter {
  private readonly u = emptyUsage();

  record(elapsedMs: number, tokens?: CallTokens): void {
    this.u.calls += 1;
    this.u.activeMs += Math.max(0, elapsedMs);
    if (tokens) {
      this.u.promptTokens += tokens.prompt;
      this.u.completionTokens += tokens.completion;
      this.u.totalTokens += tokens.total;
      this.u.reportedCalls += 1;
    }
  }

  // A copy, so callers can't mutate the meter's internal state.
  get(): RunUsage {
    return { ...this.u };
  }
}
