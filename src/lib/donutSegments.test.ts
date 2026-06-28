import { describe, it, expect } from 'vitest';
import { donutSegments } from './donutSegments.js';

const C = 100; // round circumference makes arc == pct*100 easy to assert

describe('donutSegments', () => {
  it('returns an empty array when the total is zero', () => {
    expect(donutSegments([{ key: 'a', count: 0 }, { key: 'b', count: 0 }], C)).toEqual([]);
  });

  it('returns an empty array for an empty input', () => {
    expect(donutSegments([], C)).toEqual([]);
  });

  it('splits proportionally and accumulates offsets', () => {
    const segs = donutSegments([{ key: 'a', count: 3 }, { key: 'b', count: 1 }], C);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ key: 'a', count: 3, pct: 0.75, dashArray: '75 25', dashOffset: -0 });
    // second arc starts where the first ended (offset = -firstArcLength)
    expect(segs[1]).toMatchObject({ key: 'b', count: 1, pct: 0.25, dashArray: '25 75', dashOffset: -75 });
  });

  it('drops zero-count entries but keeps cumulative offsets correct', () => {
    const segs = donutSegments([
      { key: 'a', count: 1 },
      { key: 'zero', count: 0 },
      { key: 'b', count: 1 },
    ], C);
    expect(segs.map((s) => s.key)).toEqual(['a', 'b']);
    expect(segs[1].dashOffset).toBe(-50); // 'zero' contributes no arc length
  });

  it('a single non-zero bucket fills the ring', () => {
    const segs = donutSegments([{ key: 'only', count: 5 }], C);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ pct: 1, dashArray: '100 0', dashOffset: -0 });
  });
});
