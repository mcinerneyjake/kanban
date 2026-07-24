import { describe, it, expect, vi } from 'vitest';
import { runEval, formatReport } from './harness.js';

describe('runEval', () => {
  it('asserts instruments BEFORE scoring any case, and never scores when they throw', async () => {
    const scoreCase = vi.fn();
    await expect(runEval({
      name: 'x',
      cases: [1, 2, 3],
      assertInstruments: () => Promise.reject(new Error('instrument down')),
      scoreCase,
      summarize: () => ({ metrics: {}, lines: [] }),
    })).rejects.toThrow('instrument down');
    // The whole point of assert-first: a broken instrument means ZERO cases run.
    expect(scoreCase).not.toHaveBeenCalled();
  });

  it('runs every case in order and threads results into summarize', async () => {
    const seen: number[] = [];
    const report = await runEval<number, number>({
      name: 'doubler',
      cases: [1, 2, 3],
      assertInstruments: () => Promise.resolve(),
      scoreCase: (c) => { seen.push(c); return Promise.resolve(c * 2); },
      summarize: (results) => ({ metrics: { sum: results.reduce((a, b) => a + b, 0) }, lines: results.map(String) }),
    });
    expect(seen).toEqual([1, 2, 3]);              // in order
    expect(report.results).toEqual([2, 4, 6]);
    expect(report.metrics.sum).toBe(12);
  });
});

describe('formatReport', () => {
  it('renders the name, case count, lines, and fixed-precision metrics', () => {
    const text = formatReport({ name: 'demo', results: [1, 2], metrics: { recallAt1: 0.5 }, lines: ['  line a'] });
    expect(text).toContain('=== demo (2 cases) ===');
    expect(text).toContain('  line a');
    expect(text).toContain('recallAt1: 0.500');
  });
});
