import { describe, it, expect } from 'vitest';
import { linePoints, toLinePath, toAreaPath } from './linePath.js';

describe('linePoints', () => {
  it('returns [] for an empty series', () => {
    expect(linePoints({ values: [], width: 100, height: 50 })).toEqual([]);
  });

  it('centers a single point horizontally', () => {
    const [p] = linePoints({ values: [5], width: 100, height: 50 });
    expect(p.x).toBe(50);
  });

  it('spreads points evenly across the inner width', () => {
    const pts = linePoints({ values: [0, 1, 2], width: 100, height: 50, pad: 10 });
    expect(pts.map((p) => p.x)).toEqual([10, 50, 90]); // pad, mid, width-pad
  });

  it('puts the max at the top and the min at the bottom (inset by pad)', () => {
    const pts = linePoints({ values: [10, 20], width: 100, height: 100, pad: 10 });
    expect(pts[0].y).toBe(90); // min → bottom (height - pad)
    expect(pts[1].y).toBe(10); // max → top (pad)
  });

  it('places a flat series on the midline (no divide-by-zero)', () => {
    const pts = linePoints({ values: [7, 7, 7], width: 90, height: 40 });
    expect(pts.every((p) => p.y === 20)).toBe(true);
  });
});

describe('toLinePath', () => {
  it('builds an M…L polyline through the points', () => {
    expect(toLinePath([{ x: 0, y: 10 }, { x: 5, y: 2 }])).toBe('M0 10 L5 2');
  });
  it('is empty for no points', () => {
    expect(toLinePath([])).toBe('');
  });
});

describe('toAreaPath', () => {
  it('closes the line down to the baseline at both ends', () => {
    expect(toAreaPath([{ x: 0, y: 10 }, { x: 5, y: 2 }], 40)).toBe('M0 10 L5 2 L5 40 L0 40 Z');
  });
  it('is empty for no points', () => {
    expect(toAreaPath([], 40)).toBe('');
  });
});
