import { describe, it, expect } from 'vitest';
import {
  CONTROLS, assertInstruments, controlFailures, naiveTestBlocks, screenBlock, stripNoise, sweep, testBlocks,
} from './vacuous-tests.mjs';

/**
 * The probe's own tests. Its job is to say when a test asserts nothing, so the thing worth proving is
 * that IT would notice its own breakage — a screen that quietly stops matching reports a clean suite.
 */

const only = (source) => {
  const blocks = testBlocks(source);
  if (blocks.length !== 1) throw new Error(`expected 1 block, parsed ${blocks.length}`);
  return blocks[0];
};

describe('the controls', () => {
  it('all pass on the current instrument', () => {
    expect(controlFailures()).toEqual([]);
    expect(() => assertInstruments()).not.toThrow();
  });

  it.each(CONTROLS.positive.map((c) => [c[0], c[1], c[2]]))('positive: %s fires', (_name, source, expected) => {
    expect(screenBlock(only(source))).toContain(expected);
  });

  it.each(CONTROLS.negative.map((c) => [c[0], c[1]]))('negative: %s stays quiet', (_name, source) => {
    expect(screenBlock(only(source))).toEqual([]);
  });

  it.each(CONTROLS.zeroBlock.map((c) => [c[0], c[1]]))('zero-block: %s is not a test', (_name, source) => {
    expect(testBlocks(source)).toEqual([]);
  });

  /** There must BE controls — an empty control set passes `controlFailures()` trivially. */
  it('has controls in every category', () => {
    expect(CONTROLS.positive.length).toBeGreaterThanOrEqual(4);
    expect(CONTROLS.negative.length).toBeGreaterThanOrEqual(6);
    expect(CONTROLS.zeroBlock.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The four bugs the first hand-run actually hit, each reconstructed against the naive parser.
 *
 * This is the `naiveAiCoAuthoredGrep` precedent: the broken version is kept and watched to fail, so
 * the fix is demonstrated rather than asserted. Every case below reported a test that has assertions
 * as having none.
 */
describe('the parser bugs that made the first sweep lie', () => {
  const cases = [
    ['an it.each table is screened instead of the callback', "it.each([['a', 1], ['b', 2]])('handles %s', (n, v) => { expect(f(n)).toBe(v); });"],
    ['a regex literal with escaped parens truncates the block', "it('parses', () => { const m = /CHECK \\(x IN \\(([^)]*)\\)\\)/.exec(sql); expect(m).not.toBeNull(); });"],
  ];

  it.each(cases)('%s', (_name, source) => {
    expect(screenBlock(only(source))).toEqual([]);
    const naive = naiveTestBlocks(source);
    const naiveHits = naive.flatMap((block) => screenBlock(block));
    expect(naiveHits).toContain('NO-ASSERTION: block contains no assertion at all');
  });

  it('a .test() method call is read as a test block', () => {
    const source = 'const isTest = (rel) => /\\.test\\.ts$/.test(rel);';
    expect(testBlocks(source)).toEqual([]);
    // The naive opener has no lookbehind, so the method call becomes a block with no assertions.
    expect(naiveTestBlocks(source).length).toBeGreaterThan(0);
  });

  it('a throw-based assertion is counted as an assertion', () => {
    const source = "it('shouts', () => { for (const x of xs) { if (bad(x)) throw new Error('nope'); } });";
    expect(screenBlock(only(source))).toEqual([]);
  });
});

describe('stripNoise', () => {
  it('preserves length and line count, so reported lines are the real ones', () => {
    const source = "const a = 1; // a ( comment\nconst b = 'a ) string';\nconst c = /x\\(y/;\n";
    const stripped = stripNoise(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('leaves division alone rather than eating the rest of the line as a regex', () => {
    const block = only("it('divides', () => { const half = total / 2; expect(half).toBe(3); });");
    expect(screenBlock(block)).toEqual([]);
  });
});

describe('assertInstruments', () => {
  /**
   * The load-bearing behaviour: a broken screen must refuse, not return an empty candidate list.
   * Proven by feeding a control the screen cannot satisfy rather than by trusting the wiring.
   */
  it('throws instead of reporting when a control fails', () => {
    const positive = [...CONTROLS.positive];
    CONTROLS.positive.push(['impossible', "it('nothing', () => { expect(real()).toBe(1); });", 'LITERAL: a literal asserted against a literal']);
    try {
      expect(controlFailures().length).toBeGreaterThan(0);
      expect(() => assertInstruments()).toThrow(/control\(s\) failed/);
      expect(() => sweep(process.cwd())).toThrow(/Refusing to report a clean sweep/);
    } finally {
      CONTROLS.positive.length = 0;
      CONTROLS.positive.push(...positive);
    }
    expect(controlFailures()).toEqual([]);
  });
});

describe('sweeping this repo', () => {
  const result = sweep(process.cwd());

  it('finds the test files, so the sweep is not vacuous', () => {
    expect(result.files).toBeGreaterThan(10);
    expect(result.blocks).toBeGreaterThan(100);
  });

  /**
   * Reported, not enforced. A threshold here would turn an advisory screen into a gate that a
   * legitimate new loop could fail, and the candidates need a human read — see the ticket.
   */
  it('reports its candidates as data', () => {
    expect(Array.isArray(result.candidates)).toBe(true);
    for (const candidate of result.candidates) {
      expect(candidate.hits.length).toBeGreaterThan(0);
      expect(candidate.file).toMatch(/\.test\./);
    }
  });
});
