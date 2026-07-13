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

// Cast-free validator for a persisted RunUsage (run log reads). Every numeric
// field must be a number and cachedReported a boolean — a malformed record is
// rejected rather than trusted.
export function isRunUsage(v: unknown): v is RunUsage {
  return typeof v === 'object' && v !== null
    && 'promptTokens' in v && typeof v.promptTokens === 'number'
    && 'completionTokens' in v && typeof v.completionTokens === 'number'
    && 'totalTokens' in v && typeof v.totalTokens === 'number'
    && 'calls' in v && typeof v.calls === 'number'
    && 'reportedCalls' in v && typeof v.reportedCalls === 'number'
    && 'activeMs' in v && typeof v.activeMs === 'number'
    && 'cachedTokens' in v && typeof v.cachedTokens === 'number'
    && 'cachedReported' in v && typeof v.cachedReported === 'boolean';
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

// The marginal usage between a baseline and a later reading of the SAME meter —
// e.g. an embedder used first to build the index and then to embed a run's
// queries: subtracting the post-build baseline isolates just the run's cost, so
// a one-time index build doesn't get charged to a single run. Fields are clamped
// at 0 (the later reading is always ≥ the baseline for a monotonic meter).
export function subtractUsage(later: RunUsage, baseline: RunUsage): RunUsage {
  return {
    promptTokens: Math.max(0, later.promptTokens - baseline.promptTokens),
    completionTokens: Math.max(0, later.completionTokens - baseline.completionTokens),
    totalTokens: Math.max(0, later.totalTokens - baseline.totalTokens),
    calls: Math.max(0, later.calls - baseline.calls),
    reportedCalls: Math.max(0, later.reportedCalls - baseline.reportedCalls),
    activeMs: Math.max(0, later.activeMs - baseline.activeMs),
    cachedTokens: Math.max(0, later.cachedTokens - baseline.cachedTokens),
    cachedReported: later.cachedReported,
  };
}
