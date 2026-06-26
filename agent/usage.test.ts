import { describe, it, expect } from 'vitest';
import { UsageMeter, emptyUsage } from './usage.js';

describe('UsageMeter', () => {
  it('starts empty', () => {
    expect(new UsageMeter().get()).toEqual(emptyUsage());
  });

  it('records a call without tokens: counts the call + time, tokens stay unavailable', () => {
    const m = new UsageMeter();
    m.record(12);
    expect(m.get()).toMatchObject({ calls: 1, reportedCalls: 0, activeMs: 12, totalTokens: 0 });
  });

  it('records tokens when reported and accumulates across calls', () => {
    const m = new UsageMeter();
    m.record(10, { prompt: 5, completion: 2, total: 7 });
    m.record(20, { prompt: 3, completion: 1, total: 4 });
    expect(m.get()).toMatchObject({
      promptTokens: 8, completionTokens: 3, totalTokens: 11, calls: 2, reportedCalls: 2, activeMs: 30,
    });
  });

  it('mixes reported and unreported calls', () => {
    const m = new UsageMeter();
    m.record(5, { prompt: 1, completion: 1, total: 2 });
    m.record(5);
    expect(m.get()).toMatchObject({ calls: 2, reportedCalls: 1, totalTokens: 2, activeMs: 10 });
  });

  it('clamps negative durations to zero', () => {
    const m = new UsageMeter();
    m.record(-7);
    expect(m.get().activeMs).toBe(0);
  });

  it('get() returns a copy — callers cannot mutate internal state', () => {
    const m = new UsageMeter();
    m.record(5, { prompt: 1, completion: 1, total: 2 });
    const snap = m.get();
    snap.totalTokens = 999;
    expect(m.get().totalTokens).toBe(2);
  });

  it('records a zero-duration call (counted, activeMs stays 0)', () => {
    const m = new UsageMeter();
    m.record(0);
    expect(m.get()).toMatchObject({ calls: 1, activeMs: 0 });
  });

  it('still adds tokens when the duration is clamped', () => {
    const m = new UsageMeter();
    m.record(-5, { prompt: 2, completion: 1, total: 3 });
    expect(m.get()).toMatchObject({ activeMs: 0, totalTokens: 3, reportedCalls: 1 });
  });

  it('accumulates cached tokens and flags cachedReported when reported', () => {
    const m = new UsageMeter();
    m.record(5, { prompt: 10, completion: 2, total: 12, cached: 4 });
    m.record(5, { prompt: 8, completion: 1, total: 9, cached: 6 });
    expect(m.get()).toMatchObject({ cachedTokens: 10, cachedReported: true });
  });

  it('leaves cachedReported false when no call reports cached tokens', () => {
    const m = new UsageMeter();
    m.record(5, { prompt: 10, completion: 2, total: 12 });
    expect(m.get()).toMatchObject({ cachedTokens: 0, cachedReported: false });
  });

  it('treats a reported cached:0 as reported (0 hits), not unreported', () => {
    const m = new UsageMeter();
    m.record(5, { prompt: 10, completion: 2, total: 12, cached: 0 });
    expect(m.get()).toMatchObject({ cachedTokens: 0, cachedReported: true });
  });
});
