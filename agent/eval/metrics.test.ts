import { describe, it, expect } from 'vitest';
import { rankOf, recallAtK, reciprocalRank, aggregate } from './metrics.js';

describe('rankOf', () => {
  it('is 1-based and null when absent', () => {
    expect(rankOf(['a', 'b', 'c'], 'a')).toBe(1);
    expect(rankOf(['a', 'b', 'c'], 'c')).toBe(3);
    expect(rankOf(['a', 'b', 'c'], 'z')).toBeNull();
    expect(rankOf([], 'a')).toBeNull();
  });
});

describe('recallAtK', () => {
  it('hits within k, misses outside k, boundary inclusive', () => {
    const ranked = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(recallAtK(ranked, 'a', 1)).toBe(true);
    expect(recallAtK(ranked, 'b', 1)).toBe(false);
    expect(recallAtK(ranked, 'e', 5)).toBe(true);   // rank 5, k 5 — inclusive
    expect(recallAtK(ranked, 'f', 5)).toBe(false);  // rank 6
    expect(recallAtK(ranked, 'z', 5)).toBe(false);  // absent
  });

  it('rejects a non-positive or non-integer k rather than silently misreporting', () => {
    expect(() => recallAtK(['a'], 'a', 0)).toThrow(/positive integer/);
    expect(() => recallAtK(['a'], 'a', 2.5)).toThrow(/positive integer/);
  });
});

describe('reciprocalRank', () => {
  it('is 1/rank, or 0 when absent', () => {
    expect(reciprocalRank(['a', 'b'], 'a')).toBe(1);
    expect(reciprocalRank(['a', 'b'], 'b')).toBe(0.5);
    expect(reciprocalRank(['a', 'b'], 'z')).toBe(0);
  });
});

describe('aggregate', () => {
  it('averages recall@1 / recall@5 / MRR over cases', () => {
    const m = aggregate([
      { rankedIds: ['x', 'a'], expectedId: 'x' },   // rank 1
      { rankedIds: ['a', 'y', 'z'], expectedId: 'y' }, // rank 2
      { rankedIds: ['a', 'b', 'c', 'd', 'e', 'q'], expectedId: 'q' }, // rank 6 (miss@5)
    ]);
    expect(m.n).toBe(3);
    expect(m.recallAt1).toBeCloseTo(1 / 3);          // only the first
    expect(m.recallAt5).toBeCloseTo(2 / 3);          // first two
    expect(m.mrr).toBeCloseTo((1 + 0.5 + 1 / 6) / 3);
  });

  it('empty input yields all-zero n:0 rather than dividing by zero', () => {
    expect(aggregate([])).toEqual({ n: 0, recallAt1: 0, recallAt5: 0, mrr: 0 });
  });

  it('a total miss set scores zero across the board', () => {
    const m = aggregate([{ rankedIds: ['a', 'b'], expectedId: 'z' }]);
    expect(m).toMatchObject({ recallAt1: 0, recallAt5: 0, mrr: 0 });
  });
});
