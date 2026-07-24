import { describe, it, expect } from 'vitest';
import { UsageMeter, emptyUsage, mergeUsage, subtractUsage, isRunUsage, type RecordedCall, type CallTrace, type RunUsage } from './usage.js';

// Terse builder — most tests care about duration/tokens, not kind or size.
function call(elapsedMs: number, tokens?: RecordedCall['tokens'], over: Partial<RecordedCall> = {}): RecordedCall {
  return { kind: 'chat', startedAt: 0, elapsedMs, inputChars: 0, ...(tokens ? { tokens } : {}), ...over };
}

// callTrace is optional (undefined == a pre-trace record). Every assertion below is about a LIVE
// meter, which always records one — so demand it rather than silently treating absent as empty.
function traceOf(u: RunUsage): CallTrace[] {
  if (!u.callTrace) throw new Error('expected a recorded callTrace, got undefined');
  return u.callTrace;
}

describe('UsageMeter', () => {
  it('starts empty', () => {
    expect(new UsageMeter().get()).toEqual(emptyUsage());
  });

  it('records a call without tokens: counts the call + time, tokens stay unavailable', () => {
    const m = new UsageMeter();
    m.record(call(12));
    expect(m.get()).toMatchObject({ calls: 1, reportedCalls: 0, activeMs: 12, totalTokens: 0 });
  });

  it('records tokens when reported and accumulates across calls', () => {
    const m = new UsageMeter();
    m.record(call(10, { prompt: 5, completion: 2, total: 7 }));
    m.record(call(20, { prompt: 3, completion: 1, total: 4 }));
    expect(m.get()).toMatchObject({
      promptTokens: 8, completionTokens: 3, totalTokens: 11, calls: 2, reportedCalls: 2, activeMs: 30,
    });
  });

  it('mixes reported and unreported calls', () => {
    const m = new UsageMeter();
    m.record(call(5, { prompt: 1, completion: 1, total: 2 }));
    m.record(call(5));
    expect(m.get()).toMatchObject({ calls: 2, reportedCalls: 1, totalTokens: 2, activeMs: 10 });
  });

  it('clamps negative durations to zero', () => {
    const m = new UsageMeter();
    m.record(call(-7));
    expect(m.get().activeMs).toBe(0);
  });

  it('get() returns a copy — callers cannot mutate internal state', () => {
    const m = new UsageMeter();
    m.record(call(5, { prompt: 1, completion: 1, total: 2 }));
    const snap = m.get();
    snap.totalTokens = 999;
    traceOf(snap).push({ kind: 'chat', startedAt: 0, ms: 1, inputChars: 0 });
    expect(m.get().totalTokens).toBe(2);
    expect(traceOf(m.get())).toHaveLength(1); // the array is copied too, not shared
  });

  // Review finding (tkt-1e98c78e8c01): the array copy alone still aliased the entry objects, so a
  // consumer mutating a returned entry corrupted the live meter and everything it later persisted.
  it('get() deep-copies trace entries — mutating a returned entry cannot corrupt the meter', () => {
    const m = new UsageMeter();
    m.record(call(5, { prompt: 3, completion: 1, total: 4 }, { inputChars: 100 }));
    const entry = traceOf(m.get())[0];
    entry.inputChars = 0;
    if (entry.tokens) entry.tokens.prompt = 999;
    const fresh = traceOf(m.get())[0];
    expect(fresh.inputChars).toBe(100);
    expect(fresh.tokens?.prompt).toBe(3);
  });

  it('records a zero-duration call (counted, activeMs stays 0)', () => {
    const m = new UsageMeter();
    m.record(call(0));
    expect(m.get()).toMatchObject({ calls: 1, activeMs: 0 });
  });

  it('still adds tokens when the duration is clamped', () => {
    const m = new UsageMeter();
    m.record(call(-5, { prompt: 2, completion: 1, total: 3 }));
    expect(m.get()).toMatchObject({ activeMs: 0, totalTokens: 3, reportedCalls: 1 });
  });

  it('accumulates cached tokens and flags cachedReported when reported', () => {
    const m = new UsageMeter();
    m.record(call(5, { prompt: 10, completion: 2, total: 12, cached: 4 }));
    m.record(call(5, { prompt: 8, completion: 1, total: 9, cached: 6 }));
    expect(m.get()).toMatchObject({ cachedTokens: 10, cachedReported: true });
  });

  it('leaves cachedReported false when no call reports cached tokens', () => {
    const m = new UsageMeter();
    m.record(call(5, { prompt: 10, completion: 2, total: 12 }));
    expect(m.get()).toMatchObject({ cachedTokens: 0, cachedReported: false });
  });

  it('treats a reported cached:0 as reported (0 hits), not unreported', () => {
    const m = new UsageMeter();
    m.record(call(5, { prompt: 10, completion: 2, total: 12, cached: 0 }));
    expect(m.get()).toMatchObject({ cachedTokens: 0, cachedReported: true });
  });
});

describe('UsageMeter callTrace (tkt-1e98c78e8c01)', () => {
  it('records one trace entry per call, carrying kind, start, duration and input size', () => {
    const m = new UsageMeter();
    m.record(call(65_000, undefined, { kind: 'embed', startedAt: 1_000, inputChars: 1_267_300 }));
    m.record(call(700, { prompt: 924, completion: 57, total: 981 }, { startedAt: 66_000, inputChars: 3_700 }));
    expect(traceOf(m.get())).toEqual([
      { kind: 'embed', startedAt: 1_000, ms: 65_000, inputChars: 1_267_300 },
      { kind: 'chat', startedAt: 66_000, ms: 700, inputChars: 3_700, tokens: { prompt: 924, completion: 57, total: 981 } },
    ]);
  });

  // The invariant the whole ticket rests on: a trace that doesn't sum to activeMs can't attribute it.
  it('keeps the trace reconciled to the aggregate (sum of ms === activeMs, length === calls)', () => {
    const m = new UsageMeter();
    m.record(call(30));
    m.record(call(-9)); // clamped in BOTH places, or the two drift apart
    m.record(call(12, { prompt: 1, completion: 1, total: 2 }));
    const u = m.get();
    expect(traceOf(u).reduce((n, c) => n + c.ms, 0)).toBe(u.activeMs);
    expect(traceOf(u)).toHaveLength(u.calls);
  });

  it('omits tokens entirely on an unreported call rather than storing zeros', () => {
    const m = new UsageMeter();
    m.record(call(5));
    expect(traceOf(m.get())[0].tokens).toBeUndefined();
  });
});

describe('isRunUsage with callTrace', () => {
  it('accepts a well-formed usage record', () => {
    expect(isRunUsage(emptyUsage())).toBe(true);
    const m = new UsageMeter();
    m.record(call(5, { prompt: 1, completion: 1, total: 2 }, { kind: 'embed' }));
    expect(isRunUsage(m.get())).toBe(true);
  });

  // Regression guard: a strict validator here silently discarded all 128 pre-trace runs on read,
  // blanking the economics dashboard. Absent means "not recorded" and stays readable.
  it('ACCEPTS a record with no callTrace (a pre-trace log line is still a valid run)', () => {
    const legacy: Record<string, unknown> = { ...emptyUsage() };
    delete legacy.callTrace;
    expect(isRunUsage(legacy)).toBe(true);
    expect(isRunUsage({ ...emptyUsage(), callTrace: undefined })).toBe(true);
  });

  // …but absent must stay distinguishable from []. Collapsing them would make a pre-trace run read
  // as "0 calls traced, 128s active" — the same measured-vs-unreported error tkt-78eedf738778 fixes.
  it('preserves undefined (not recorded) rather than defaulting to an empty trace', () => {
    const legacy: RunUsage = { ...emptyUsage(), callTrace: undefined, activeMs: 128_000, calls: 12 };
    expect(mergeUsage(legacy, { ...emptyUsage(), callTrace: undefined }).callTrace).toBeUndefined();
    expect(subtractUsage(legacy, emptyUsage()).callTrace).toBeUndefined();
  });

  // Review findings (tkt-1e98c78e8c01): a merge/subtract touching ONE untraced side must not emit a
  // partial trace — its length/ms would under-count the summed activeMs/calls, a complete-looking
  // lie. The whole-struct invariant (trace present ⇒ length===calls ∧ ms-sum===activeMs) is what's
  // being protected: when it can't hold, the trace is `undefined`, not partial.
  it('mergeUsage yields undefined when EITHER side is untraced, never a partial trace', () => {
    const legacy: RunUsage = { ...emptyUsage(), callTrace: undefined, activeMs: 100, calls: 5 };
    const live = { ...emptyUsage(), activeMs: 15, calls: 2, callTrace: [
      { kind: 'chat' as const, startedAt: 200, ms: 10, inputChars: 0 },
      { kind: 'embed' as const, startedAt: 300, ms: 5, inputChars: 0 },
    ] };
    expect(mergeUsage(legacy, live).callTrace).toBeUndefined();
    expect(mergeUsage(live, legacy).callTrace).toBeUndefined();
    // sanity: two traced sides still merge (and stay reconciled)
    const merged = mergeUsage(live, { ...emptyUsage(), activeMs: 4, calls: 1, callTrace: [{ kind: 'chat' as const, startedAt: 250, ms: 4, inputChars: 0 }] });
    expect(traceOf(merged)).toHaveLength(merged.calls);
    expect(traceOf(merged).reduce((n, c) => n + c.ms, 0)).toBe(merged.activeMs);
  });

  it('subtractUsage yields undefined when the baseline is untraced (cannot know which calls to drop)', () => {
    const later = { ...emptyUsage(), activeMs: 30, calls: 3, callTrace: [
      { kind: 'embed' as const, startedAt: 0, ms: 10, inputChars: 0 },
      { kind: 'chat' as const, startedAt: 10, ms: 12, inputChars: 0 },
      { kind: 'chat' as const, startedAt: 22, ms: 8, inputChars: 0 },
    ] };
    // Untraced baseline with real scalar cost — slicing off 0 would return all 3 as the "delta".
    const untracedBaseline: RunUsage = { ...emptyUsage(), callTrace: undefined, activeMs: 10, calls: 1 };
    expect(subtractUsage(later, untracedBaseline).callTrace).toBeUndefined();
  });

  it('rejects a malformed trace entry — bad kind, wrong types, or a malformed tokens block', () => {
    const bad = (entry: unknown): boolean => isRunUsage({ ...emptyUsage(), callTrace: [entry] });
    expect(bad({ kind: 'audio', startedAt: 0, ms: 1, inputChars: 0 })).toBe(false);
    expect(bad({ kind: 'chat', startedAt: 0, ms: 'soon', inputChars: 0 })).toBe(false);
    expect(bad({ kind: 'chat', startedAt: 0, ms: 1 })).toBe(false); // inputChars missing
    expect(bad({ kind: 'chat', startedAt: 0, ms: 1, inputChars: 0, tokens: { prompt: 1 } })).toBe(false);
    expect(bad({ kind: 'chat', startedAt: 0, ms: 1, inputChars: 0, tokens: { prompt: 1, completion: 1, total: 2 } })).toBe(true);
  });
});

describe('mergeUsage', () => {
  it('sums numeric fields and ORs cachedReported', () => {
    const a = { ...emptyUsage(), promptTokens: 10, totalTokens: 12, activeMs: 100, calls: 1, reportedCalls: 1, cachedTokens: 2, cachedReported: true };
    const b = { ...emptyUsage(), promptTokens: 5, totalTokens: 6, activeMs: 50, calls: 1, reportedCalls: 1, cachedReported: false };
    expect(mergeUsage(a, b)).toMatchObject({
      promptTokens: 15, totalTokens: 18, activeMs: 150, calls: 2, reportedCalls: 2, cachedTokens: 2, cachedReported: true,
    });
  });

  it('reports cachedReported false only when neither side reported', () => {
    expect(mergeUsage(emptyUsage(), emptyUsage()).cachedReported).toBe(false);
  });

  // Merging the chat and embed meters is the ONLY place the interleaving appears — concatenating
  // would report every embed before every chat and hide the actual sequence of a run.
  it('interleaves the two meters chronologically rather than concatenating', () => {
    const embed = { ...emptyUsage(), callTrace: [
      { kind: 'embed' as const, startedAt: 100, ms: 5, inputChars: 0 },
      { kind: 'embed' as const, startedAt: 900, ms: 5, inputChars: 0 },
    ] };
    const chat = { ...emptyUsage(), callTrace: [
      { kind: 'chat' as const, startedAt: 500, ms: 5, inputChars: 0 },
      { kind: 'chat' as const, startedAt: 1_500, ms: 5, inputChars: 0 },
    ] };
    expect(traceOf(mergeUsage(embed, chat)).map((c) => [c.kind, c.startedAt]))
      .toEqual([['embed', 100], ['chat', 500], ['embed', 900], ['chat', 1_500]]);
  });

  it('merged trace still reconciles to merged activeMs', () => {
    const a = { ...emptyUsage(), activeMs: 10, calls: 1, callTrace: [{ kind: 'embed' as const, startedAt: 0, ms: 10, inputChars: 0 }] };
    const b = { ...emptyUsage(), activeMs: 7, calls: 1, callTrace: [{ kind: 'chat' as const, startedAt: 20, ms: 7, inputChars: 0 }] };
    const merged = mergeUsage(a, b);
    expect(traceOf(merged).reduce((n, c) => n + c.ms, 0)).toBe(merged.activeMs);
  });
});

describe('subtractUsage', () => {
  it('isolates the marginal usage between a later reading and a baseline', () => {
    const baseline = { ...emptyUsage(), promptTokens: 100, totalTokens: 100, activeMs: 5000, calls: 3, reportedCalls: 3 };
    const later = { ...emptyUsage(), promptTokens: 130, totalTokens: 138, activeMs: 5200, calls: 5, reportedCalls: 5, cachedReported: true };
    expect(subtractUsage(later, baseline)).toMatchObject({
      promptTokens: 30, totalTokens: 38, activeMs: 200, calls: 2, reportedCalls: 2, cachedReported: true,
    });
  });

  it('clamps every field at 0 (never negative)', () => {
    const baseline = { ...emptyUsage(), promptTokens: 50, totalTokens: 50, activeMs: 100, calls: 2, reportedCalls: 2 };
    expect(subtractUsage(emptyUsage(), baseline)).toEqual(emptyUsage());
  });

  it('subtracting a baseline from itself yields an empty delta', () => {
    const u = { ...emptyUsage(), promptTokens: 7, totalTokens: 9, activeMs: 42, calls: 1, reportedCalls: 1 };
    expect(subtractUsage(u, u)).toMatchObject({ promptTokens: 0, totalTokens: 0, activeMs: 0, calls: 0, reportedCalls: 0 });
  });

  // recordRun.ts:61 subtracts an embed baseline so the one-time index build isn't charged to the run.
  // The trace has to drop the same calls the scalars do, or the two disagree about what the run did.
  it('keeps only the calls added after the baseline reading', () => {
    const first = { kind: 'embed' as const, startedAt: 0, ms: 65_000, inputChars: 100 };
    const second = { kind: 'chat' as const, startedAt: 70_000, ms: 700, inputChars: 50 };
    const baseline = { ...emptyUsage(), activeMs: 65_000, calls: 1, callTrace: [first] };
    const later = { ...emptyUsage(), activeMs: 65_700, calls: 2, callTrace: [first, second] };
    const delta = subtractUsage(later, baseline);
    expect(traceOf(delta)).toEqual([second]);
    expect(traceOf(delta).reduce((n, c) => n + c.ms, 0)).toBe(delta.activeMs);
  });

  it('yields no trace when `later` is not the same meter read later (shorter than baseline)', () => {
    const baseline = { ...emptyUsage(), callTrace: [
      { kind: 'chat' as const, startedAt: 0, ms: 1, inputChars: 0 },
      { kind: 'chat' as const, startedAt: 1, ms: 1, inputChars: 0 },
    ] };
    expect(subtractUsage(emptyUsage(), baseline).callTrace).toEqual([]);
  });
});
