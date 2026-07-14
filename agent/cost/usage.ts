// Per-run accounting for runtime calls (chat + embeddings). activeMs is summed model-call duration, NOT run wall-clock — wall-clock includes retrieval I/O + the approval-gate pause and would overstate energy.

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  /** Calls that returned a usage block — tokens are "available" iff this is > 0. */
  reportedCalls: number;
  activeMs: number;
  /** Runtime-reported cached prompt tokens (from prompt_tokens_details.cached_tokens). */
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

// Cast-free validator for a persisted RunUsage (run log reads) — a malformed record is rejected, not trusted.
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

// Accumulates timed runtime calls; token figures are added only when the runtime reported them.
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

// Marginal usage between a baseline and a later reading of the SAME meter — isolates a run's cost so a one-time index build isn't charged to it. Clamped at 0 (a monotonic meter's later reading is always ≥ baseline).
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
