import { describe, it, expect } from 'vitest';
import {
  compareToBaseline, parseBaseline, hashGoldenSet, readMetrics,
  type Baseline, type Measurement,
} from './baseline.js';
import type { GoldenSet } from './golden.js';

// The comparison is deliberately non-blocking, which makes it the easy place for a silent wrong
// answer: nothing downstream fails if it reports nonsense. So every branch is asserted directly —
// especially the refusals, which are the ones a passing build would never reveal.

const MEASUREMENT: Measurement = {
  corpus: 'fixture corpus',
  corpusSize: 48,
  corpusHash: 'abc123def4567890',
  goldenSetHash: '0987654321fedcba',
  searchDepth: 10,
  embedModel: 'text-embedding-qwen3-embedding-0.6b',
  embedBaseUrl: 'http://localhost:1234/v1',
  queryInstruction: 'query: ',
  docInstruction: '',
  metrics: { recallAt1: 0.75, recallAt5: 0.92, mrr: 0.81 },
};

function baselineOf(over: Partial<Baseline> = {}): Baseline {
  return { recordedAt: '2026-09-09T00:00:00.000Z', ...MEASUREMENT, ...over };
}

function measurementOf(over: Partial<Measurement> = {}): Measurement {
  return { ...MEASUREMENT, ...over };
}

describe('parseBaseline', () => {
  const VALID = JSON.stringify(baselineOf());

  it('round-trips a well-formed baseline', () => {
    expect(parseBaseline(VALID)).toEqual(baselineOf());
  });

  it('accepts the committed baseline.json, so the real file cannot drift out of shape', async () => {
    const { readFile } = await import('node:fs/promises');
    const { BASELINE_PATH } = await import('./retrievalEval.js');
    expect(() => parseBaseline('')).toThrow(); // control: the assertion below is capable of failing
    const raw = await readFile(BASELINE_PATH, 'utf8');
    expect(() => parseBaseline(raw)).not.toThrow();
  });

  // A corrupt baseline must be LOUD. Cast blindly it would compare against undefined and print a
  // NaN delta, which reads exactly like a real measurement.
  it.each([
    ['not JSON at all', '{'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['metrics missing', JSON.stringify({ ...baselineOf(), metrics: undefined })],
    ['metrics not an object', JSON.stringify({ ...baselineOf(), metrics: 'nope' })],
    ['a metric missing', JSON.stringify({ ...baselineOf(), metrics: { recallAt1: 1, recallAt5: 1 } })],
    ['a metric as a string', JSON.stringify({ ...baselineOf(), metrics: { recallAt1: '1', recallAt5: 1, mrr: 1 } })],
    ['a metric as NaN', JSON.stringify({ ...baselineOf(), metrics: { recallAt1: null, recallAt5: 1, mrr: 1 } })],
    ['embedModel missing', JSON.stringify({ ...baselineOf(), embedModel: undefined })],
    ['corpusSize as a string', JSON.stringify({ ...baselineOf(), corpusSize: '61' })],
    ['corpusHash missing', JSON.stringify({ ...baselineOf(), corpusHash: undefined })],
    ['goldenSetHash missing', JSON.stringify({ ...baselineOf(), goldenSetHash: undefined })],
    ['embedBaseUrl missing', JSON.stringify({ ...baselineOf(), embedBaseUrl: undefined })],
  ])('throws on %s', (_label, raw) => {
    expect(() => parseBaseline(raw)).toThrow();
  });

  it('accepts an empty docInstruction, which is a legitimate value and not a missing field', () => {
    expect(parseBaseline(JSON.stringify(baselineOf({ docInstruction: '' }))).docInstruction).toBe('');
  });
});

describe('hashGoldenSet', () => {
  const SET: GoldenSet = {
    name: 'x',
    pairs: [{ query: 'a', expectedId: 'tkt-a' }, { query: 'b', expectedId: 'tkt-b' }],
    positive: { query: 'p', expectedId: 'tkt-p' },
    negative: { query: 'n', maxTopScore: 0.42 },
  };

  it('is stable across calls and independent of pair order', () => {
    const reordered: GoldenSet = { ...SET, pairs: [...SET.pairs].reverse() };
    expect(hashGoldenSet(SET)).toBe(hashGoldenSet(SET));
    expect(hashGoldenSet(reordered)).toBe(hashGoldenSet(SET));
  });

  // Each of these changes what is being asked while leaving the pair COUNT identical — the whole
  // reason a length or size check cannot stand in for a hash.
  it.each([
    ['a reworded query', { pairs: [{ query: 'a!', expectedId: 'tkt-a' }, SET.pairs[1]] }],
    ['a re-pointed anchor', { pairs: [{ query: 'a', expectedId: 'tkt-z' }, SET.pairs[1]] }],
    ['a different positive control', { positive: { query: 'p2', expectedId: 'tkt-p' } }],
    ['a moved negative threshold', { negative: { query: 'n', maxTopScore: 0.50 } }],
  ])('changes when %s', (_label, over: Partial<GoldenSet>) => {
    expect(hashGoldenSet({ ...SET, ...over })).not.toBe(hashGoldenSet(SET));
  });

  it('ignores the set name, which labels the report rather than the experiment', () => {
    expect(hashGoldenSet({ ...SET, name: 'renamed' })).toBe(hashGoldenSet(SET));
  });
});

describe('readMetrics', () => {
  it('reads the three metrics', () => {
    expect(readMetrics({ recallAt1: 1, recallAt5: 0.5, mrr: 0.25 }))
      .toEqual({ recallAt1: 1, recallAt5: 0.5, mrr: 0.25 });
  });

  it.each([
    ['a renamed key', { recall_at_1: 1, recallAt5: 1, mrr: 1 }],
    ['a dropped key', { recallAt1: 1, recallAt5: 1 }],
    ['a NaN value', { recallAt1: NaN, recallAt5: 1, mrr: 1 }],
    ['an Infinity value', { recallAt1: Infinity, recallAt5: 1, mrr: 1 }],
  ])('throws on %s rather than recording undefined', (_label, metrics) => {
    expect(() => readMetrics(metrics)).toThrow(/missing a finite/);
  });
});

describe('compareToBaseline', () => {
  it('reports no baseline rather than inventing a comparison', () => {
    const c = compareToBaseline(null, measurementOf());
    expect(c.comparable).toBe(false);
    expect(c.drifted).toEqual([]);
    expect(c.lines.join('\n')).toMatch(/No baseline recorded/);
  });

  it('is comparable and drift-free against an identical baseline', () => {
    const c = compareToBaseline(baselineOf(), measurementOf());
    expect(c.comparable).toBe(true);
    expect(c.mismatches).toEqual([]);
    expect(c.drifted).toEqual([]);
    expect(c.lines.join('\n')).toMatch(/No drift/);
  });

  it('names exactly the metrics that moved', () => {
    const c = compareToBaseline(
      baselineOf(),
      measurementOf({ metrics: { recallAt1: 0.50, recallAt5: 0.92, mrr: 0.66 } }),
    );
    expect(c.comparable).toBe(true);
    expect(c.drifted).toEqual(['recallAt1', 'mrr']);
    expect(c.lines.join('\n')).toMatch(/\(-0\.250\)/);
    expect(c.lines.join('\n')).toMatch(/NOT a failure/);
  });

  it('marks an improvement with a leading + rather than reading it as a regression', () => {
    const c = compareToBaseline(
      baselineOf(),
      measurementOf({ metrics: { ...MEASUREMENT.metrics, recallAt1: 0.95 } }),
    );
    expect(c.drifted).toEqual(['recallAt1']);
    expect(c.lines.join('\n')).toMatch(/\(\+0\.200\)/);
  });

  // Each provenance field independently invalidates the comparison — the adversary list for
  // "a delta means a regression". A per-field case is the point: a check that only looked at the
  // model would wave through a corpus that silently shrank.
  it.each([
    ['embedModel', { embedModel: 'some-other-embedding-model' }],
    ['embedBaseUrl', { embedBaseUrl: 'http://otherhost:9999/v1' }],
    ['corpus', { corpus: 'live board' }],
    ['corpusSize', { corpusSize: 47 }],
    // The two that a count alone cannot see: a reworded ticket body and a re-pointed golden pair
    // both leave corpusSize at 48 while changing what is being measured.
    ['corpusHash', { corpusHash: 'ffffffffffffffff' }],
    ['goldenSetHash', { goldenSetHash: 'eeeeeeeeeeeeeeee' }],
    ['searchDepth', { searchDepth: 5 }],
    ['queryInstruction', { queryInstruction: 'search_query: ' }],
    ['docInstruction', { docInstruction: 'passage: ' }],
  ])('refuses to compare when %s differs', (field, over: Partial<Measurement>) => {
    const c = compareToBaseline(baselineOf(), measurementOf(over));
    expect(c.comparable).toBe(false);
    expect(c.mismatches.join('\n')).toContain(field);
    // No drift is claimed when nothing was compared — reporting drift here would assert a
    // regression that was never measured.
    expect(c.drifted).toEqual([]);
    expect(c.lines.join('\n')).toMatch(/NOT comparable/);
  });

  it('lists every mismatching field, not just the first', () => {
    const c = compareToBaseline(
      baselineOf(),
      measurementOf({ embedModel: 'other', corpusSize: 12 }),
    );
    expect(c.mismatches).toHaveLength(2);
  });

  it('still prints both numbers when it refuses, marked as not compared', () => {
    const c = compareToBaseline(baselineOf(), measurementOf({ embedModel: 'other' }));
    expect(c.lines.join('\n')).toMatch(/recallAt1: 0\.750 {2}\(baseline 0\.750, not compared\)/);
  });

  it('treats float noise below the epsilon as unchanged', () => {
    const c = compareToBaseline(
      baselineOf(),
      measurementOf({ metrics: { ...MEASUREMENT.metrics, mrr: MEASUREMENT.metrics.mrr + 1e-12 } }),
    );
    expect(c.drifted).toEqual([]);
    expect(c.lines.join('\n')).toMatch(/\(unchanged\)/);
  });

  it('flags a change just above the epsilon, so the tolerance is not a blind spot', () => {
    const c = compareToBaseline(
      baselineOf(),
      measurementOf({ metrics: { ...MEASUREMENT.metrics, mrr: MEASUREMENT.metrics.mrr + 1e-3 } }),
    );
    expect(c.drifted).toEqual(['mrr']);
  });
});
