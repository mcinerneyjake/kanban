// Per-run accounting for runtime calls (chat + embeddings). activeMs is summed model-call duration, NOT run wall-clock — wall-clock includes retrieval I/O + the approval-gate pause and would overstate energy.

export type CallKind = 'chat' | 'embed';

// One runtime call, kept alongside the aggregate. The aggregate answers "how long did the run take";
// only the trace answers "doing what" — an opaque activeMs left ~63s of a real run unattributable (tkt-1e98c78e8c01).
export interface CallTrace {
  kind: CallKind;
  /** Epoch ms at call start — the ordering key once the chat and embed meters are merged. */
  startedAt: number;
  /** Clamped duration, so the trace always reconciles to activeMs. */
  ms: number;
  /** Input characters sent — the only size signal when a runtime reports no tokens (LM Studio embeddings report 0). */
  inputChars: number;
  tokens?: CallTokens;
}

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
  /**
   * Per-call breakdown. Invariant when present: length === calls, and the ms sum === activeMs.
   * `undefined` means NOT RECORDED (a run logged before tracing existed) — deliberately distinct
   * from `[]`, which means "traced, zero calls". Same measured-vs-unreported distinction as
   * `cachedReported`; collapsing them would make 128 pre-trace runs read as "0 calls, 128s active".
   */
  callTrace?: CallTrace[];
}

export function emptyUsage(): RunUsage {
  return {
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    calls: 0, reportedCalls: 0, activeMs: 0, cachedTokens: 0, cachedReported: false,
    callTrace: [],
  };
}

// A fully-isolated copy of one trace entry, including its nested `tokens` — so a returned entry
// shares no reference with the live meter. Used by UsageMeter.get().
function copyTrace(c: CallTrace): CallTrace {
  return { ...c, ...(c.tokens ? { tokens: { ...c.tokens } } : {}) };
}

function isCallTokens(v: unknown): v is CallTokens {
  return typeof v === 'object' && v !== null
    && 'prompt' in v && typeof v.prompt === 'number'
    && 'completion' in v && typeof v.completion === 'number'
    && 'total' in v && typeof v.total === 'number'
    && (!('cached' in v) || v.cached === undefined || typeof v.cached === 'number');
}

function isCallTrace(v: unknown): v is CallTrace {
  return typeof v === 'object' && v !== null
    && 'kind' in v && (v.kind === 'chat' || v.kind === 'embed')
    && 'startedAt' in v && typeof v.startedAt === 'number'
    && 'ms' in v && typeof v.ms === 'number'
    && 'inputChars' in v && typeof v.inputChars === 'number'
    && (!('tokens' in v) || v.tokens === undefined || isCallTokens(v.tokens));
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
    && 'cachedReported' in v && typeof v.cachedReported === 'boolean'
    // Absent is VALID (a pre-trace log line); malformed is not. Rejecting absent would discard
    // every run recorded before this field existed.
    && (!('callTrace' in v) || v.callTrace === undefined
      || (Array.isArray(v.callTrace) && v.callTrace.every(isCallTrace)));
}

export interface CallTokens { prompt: number; completion: number; total: number; cached?: number }

// One call as the runtime clients report it. `elapsedMs` is raw (may be negative under a skewed
// clock); the meter clamps it once, so the aggregate and the trace can never disagree.
export interface RecordedCall {
  kind: CallKind;
  startedAt: number;
  elapsedMs: number;
  inputChars: number;
  tokens?: CallTokens;
}

// Accumulates timed runtime calls; token figures are added only when the runtime reported them.
export class UsageMeter {
  private readonly u = emptyUsage();
  // Held concretely so `record` never has to narrow the optional field; get() hands out a copy.
  private readonly trace: CallTrace[] = [];

  record(call: RecordedCall): void {
    const { kind, startedAt, inputChars, tokens } = call;
    // Clamp ONCE and reuse, so activeMs and the trace can never drift apart.
    const ms = Math.max(0, call.elapsedMs);
    this.u.calls += 1;
    this.u.activeMs += ms;
    this.trace.push({ kind, startedAt, ms, inputChars, ...(tokens ? { tokens } : {}) });
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

  // A copy, so callers can't mutate the meter's internal state. The trace is DEEP-copied — a shared
  // array lets a caller push into the live meter, and a shallow element copy lets a caller mutate a
  // trace entry (e.g. redacting inputChars) and corrupt what the next get()/persist reads. `tokens`
  // is the one nested object, copied too. A live meter ALWAYS reports a trace (possibly empty); only
  // a persisted pre-trace record has none.
  get(): RunUsage {
    return { ...this.u, callTrace: this.trace.map(copyTrace) };
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
    // Chronological, not a.then.b — merging the chat and embed meters is exactly where the
    // interleaving lives, and that interleaving is the point of the trace. Requires BOTH sides
    // traced: a merge of one traced + one untraced side would carry only half the calls while
    // activeMs/calls sum both, producing a complete-LOOKING trace that under-attributes the run —
    // the very defect this trace exists to expose. When either side is unrecorded, so is the merge.
    callTrace: mergedTrace(a.callTrace, b.callTrace),
  };
}

// Merge two per-call traces into one chronological trace, but ONLY when both are present. A missing
// side means the merged trace cannot faithfully cover every call (length===calls, ms-sum===activeMs),
// so the honest answer is "not recorded" rather than a partial array that violates the invariant.
function mergedTrace(a: CallTrace[] | undefined, b: CallTrace[] | undefined): CallTrace[] | undefined {
  if (a === undefined || b === undefined) return undefined;
  return [...a, ...b].sort((x, y) => x.startedAt - y.startedAt);
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
    // The trace is append-only on one meter, so the marginal calls are the entries added after the
    // baseline reading. Requires BOTH traced: an untraced baseline can't tell us how many of
    // `later`'s calls to drop, so slicing off 0 would return ALL of them as the delta while
    // calls/activeMs are subtracted — a trace that over-counts its own scalars. Either side
    // unrecorded ⇒ the delta trace is unrecorded too.
    callTrace: later.callTrace !== undefined && baseline.callTrace !== undefined
      ? later.callTrace.slice(baseline.callTrace.length)
      : undefined,
  };
}
