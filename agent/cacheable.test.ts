import { describe, it, expect } from 'vitest';
import { estimateTokens, cacheablePrefix, cacheableLines } from './cacheable.js';
import { emptyUsage } from './usage.js';

describe('estimateTokens', () => {
  it('estimates ~4 chars per token (ceil)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
  });
});

describe('cacheablePrefix', () => {
  it('splits prefix vs dynamic and reports the cacheable fraction', () => {
    const s = cacheablePrefix('a'.repeat(120), 'b'.repeat(40)); // 30 vs 10 tokens
    expect(s.prefixTokens).toBe(30);
    expect(s.dynamicTokens).toBe(10);
    expect(s.totalTokens).toBe(40);
    expect(s.fraction).toBeCloseTo(0.75, 9);
  });

  it('returns fraction 0 for an empty request (no divide-by-zero)', () => {
    expect(cacheablePrefix('', '').fraction).toBe(0);
  });

  it('fraction is 1 when all prefix, 0 when all dynamic', () => {
    expect(cacheablePrefix('aaaa', '').fraction).toBe(1);
    expect(cacheablePrefix('', 'bbbb').fraction).toBe(0);
  });
});

describe('cacheableLines', () => {
  it('always emits the estimated % cacheable as a measured, estimate-labeled line', () => {
    const lines = cacheableLines(cacheablePrefix('a'.repeat(120), 'b'.repeat(40)), emptyUsage());
    const pct = lines.find((l) => l.label === 'cacheable prefix');
    expect(pct).toMatchObject({ amount: 75, unit: '%', kind: 'measured' });
    expect(pct?.note).toMatch(/estimate/i);
  });

  it('adds the real cached-tokens line only when the runtime reported it', () => {
    const split = cacheablePrefix('aaaa', 'bbbb');
    const withCache = cacheableLines(split, { ...emptyUsage(), cachedTokens: 40, cachedReported: true });
    const without = cacheableLines(split, { ...emptyUsage(), cachedReported: false });
    expect(withCache.find((l) => l.label === 'cached tokens (runtime)')?.amount).toBe(40);
    expect(without.find((l) => l.label === 'cached tokens (runtime)')).toBeUndefined();
  });

  it('shows the cached-tokens line with 0 when the runtime reported 0 hits', () => {
    const lines = cacheableLines(cacheablePrefix('aaaa', 'bbbb'), { ...emptyUsage(), cachedTokens: 0, cachedReported: true });
    expect(lines.find((l) => l.label === 'cached tokens (runtime)')?.amount).toBe(0);
  });
});
