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
  /** Sum of runtime-reported cached prompt tokens (prompt_tokens_details.cached_tokens). */
  cachedTokens: number;
  /** True once any call reported cached_tokens — distinguishes "0 hits" from "not reported". */
  cachedReported: boolean;
}

export function emptyUsage(): RunUsage {
  return {
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    calls: 0, reportedCalls: 0, activeMs: 0, cachedTokens: 0, cachedReported: false,
  };
}

export interface CallTokens { prompt: number; completion: number; total: number; cached?: number }

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
      if (tokens.cached !== undefined) {
        this.u.cachedTokens += tokens.cached;
        this.u.cachedReported = true;
      }
    }
  }

  // A copy, so callers can't mutate the meter's internal state.
  get(): RunUsage {
    return { ...this.u };
  }
}

// Combine two run usages (e.g. the chat client + the embedder) into one total.
export function mergeUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    calls: a.calls + b.calls,
    reportedCalls: a.reportedCalls + b.reportedCalls,
    activeMs: a.activeMs + b.activeMs,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cachedReported: a.cachedReported || b.cachedReported,
  };
}
