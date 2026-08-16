import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTROLS, assertInstruments, controlFailures, loopsIn, matcherlessExpects, naiveTestBlocks,
  screenBlock, stripNoise, sweep, testBlocks, testFiles,
} from './vacuous-tests.mjs';

/**
 * The probe's own tests.
 *
 * Its job is to say when a test asserts nothing, so what has to be proven is that IT would notice its
 * own breakage. The sweep is driven against a SEEDED fixture tree with known-vacuous and known-good
 * files, not against this repo — asserting over a live result meant asserting over an empty list, and
 * the first version of this file shipped exactly that vacuous loop.
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

  it.each(CONTROLS.positive)('positive: %s fires', (_name, source, expected) => {
    expect(screenBlock(only(source))).toContain(expected);
  });

  it.each(CONTROLS.negative)('negative: %s stays quiet', (_name, source) => {
    expect(screenBlock(only(source))).toEqual([]);
  });

  it.each(CONTROLS.oneBlock)('one-block: %s parses to exactly one block', (_name, source) => {
    expect(testBlocks(source)).toHaveLength(1);
  });

  it.each(CONTROLS.zeroBlock)('zero-block: %s is not a test', (_name, source) => {
    expect(testBlocks(source)).toEqual([]);
  });

  /** An empty control set passes `controlFailures()` trivially. */
  it('has controls in every category', () => {
    expect(CONTROLS.positive.length).toBeGreaterThanOrEqual(11);
    expect(CONTROLS.negative.length).toBeGreaterThanOrEqual(19);
    expect(CONTROLS.oneBlock.length).toBeGreaterThanOrEqual(6);
    expect(CONTROLS.zeroBlock.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The bugs that made earlier versions report a clean sweep on suites they never parsed. Each is kept
 * as an executable case rather than a comment — the `naiveAiCoAuthoredGrep` precedent.
 */
describe('the parser bugs that made earlier sweeps lie', () => {
  it.each([
    ['an it.each table screened instead of the callback', "it.each([['a', 1]])('handles %s', (n, v) => { expect(f(n)).toBe(v); });"],
    ['a regex literal with escaped parens truncating the block', "it('parses', () => { const m = /CHECK \\(x IN \\(([^)]*)\\)\\)/.exec(sql); expect(m).not.toBeNull(); });"],
  ])('%s', (_name, source) => {
    expect(screenBlock(only(source))).toEqual([]);
    const naiveHits = naiveTestBlocks(source).flatMap((block) => screenBlock(block));
    expect(naiveHits).toContain('NO-ASSERTION: block contains no assertion at all');
  });

  it('a .test() method call is read as a test block', () => {
    const source = 'const isTest = (rel) => /\\.test\\.ts$/.test(rel);';
    expect(testBlocks(source)).toEqual([]);
    expect(naiveTestBlocks(source).length).toBeGreaterThan(0);
  });

  /** The JSX bug: `</div>` opened a fake regex that blanked the line and deleted the block. */
  it('a JSX closing tag no longer eats the rest of the line', () => {
    const source = "it('renders', () => { render(<div>{fmt(x)}</div>); expect(screen.getByText('a')).toBeVisible(); });";
    expect(testBlocks(source)).toHaveLength(1);
    expect(stripNoise(source)).toHaveLength(source.length);
  });

  it('a tagged-template it.each is a block, not nothing', () => {
    const source = "it.each`\n  a    | b\n  ${1} | ${2}\n`('adds $a', ({ a, b }) => { expect(a).toBe(b); });";
    expect(testBlocks(source)).toHaveLength(1);
    expect(screenBlock(only(source))).toEqual([]);
  });

  it('a matcher-less expect is found even when a good one follows it', () => {
    expect(matcherlessExpects('{ expect(value); expect(other).toBe(1); }')).toEqual(['expect(value)']);
    expect(matcherlessExpects('{ expect(other).toBe(1); }')).toEqual([]);
  });

  /** A braceless loop's body is one statement — not 400 characters of whatever follows it. */
  it('a post-loop assertion is not attributed to the loop', () => {
    const loops = loopsIn('{ for (const x of compute(xs)) n += x; expect(n).toBe(3); }');
    expect(loops).toHaveLength(1);
    expect(loops[0].body).not.toContain('expect(');
  });
});

describe('stripNoise', () => {
  it('preserves length and line count, so reported lines are the real ones', () => {
    const source = "const a = 1; // a ( comment\nconst b = 'a ) string';\nconst c = /x\\(y/;\nconst d = <p>{y}</p>;\n";
    expect(stripNoise(source)).toHaveLength(source.length);
    expect(stripNoise(source).split('\n')).toHaveLength(source.split('\n').length);
  });

  it('leaves division alone rather than eating the rest of the line', () => {
    expect(screenBlock(only("it('divides', () => { const half = total / 2; expect(half).toBe(3); });"))).toEqual([]);
  });

  it('treats an unterminated slash as division, not a regex running off the line', () => {
    const source = 'const ratio = a / b;\nconst next = 1;\n';
    expect(stripNoise(source).split('\n')).toHaveLength(3);
  });
});

/**
 * The red control for `tkt-9c818426feb3`: reconstruct the pre-fix `isComputed` in a temp copy of the
 * module and require the new controls — and ONLY those — to fail against it.
 *
 * Asserting the count is what makes this attributable. "Some control failed" would pass if the
 * mutation happened to break something else, and a catch-all match is how a guard gets deleted with
 * the suite green (`merged-branches.test.mjs`). The mutation asserts it applied before importing,
 * because a regex that silently matches nothing reports a broken probe as a fixed one.
 */
describe('the pre-fix isComputed', () => {
  it('misses exactly the four shapes this fix added, and nothing else', async () => {
    const source = fs.readFileSync(new URL('./vacuous-tests.mjs', import.meta.url), 'utf8');
    const broken = source.replace(
      /function isComputed\(source, before = ''\) \{[\s\S]*?\n\}/,
      "function isComputed(source) {\n  if (source.startsWith('[')) return false;\n  return /[.(]/.test(source);\n}",
    );
    expect(broken).not.toBe(source); // the mutation applied

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuous-broken-'));
    try {
      const file = path.join(dir, 'broken.mjs');
      fs.writeFileSync(file, broken);
      const { controlFailures: brokenFailures } = await import(pathToFileURL(file).href);
      expect(brokenFailures().sort()).toEqual([
        'positive "loop over a $-prefixed variable": did not fire',
        'positive "loop over a spread of a computed collection": did not fire',
        'positive "loop over a variable assigned from a call": did not fire',
        'positive "loop over an array literal with a method applied": did not fire',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(controlFailures()).toEqual([]); // and the real module is untouched
  });
});

describe('assertInstruments', () => {
  /** A broken screen must refuse, not return an empty candidate list. */
  it('throws instead of reporting when a control fails', () => {
    const saved = [...CONTROLS.positive];
    CONTROLS.positive.push(['impossible', "it('nothing', () => { expect(real()).toBe(1); });", 'LITERAL: a literal asserted against a literal']);
    try {
      expect(controlFailures().length).toBeGreaterThan(0);
      expect(() => assertInstruments()).toThrow(/control\(s\) failed/);
      expect(() => sweep(process.cwd())).toThrow(/Refusing to report a clean sweep/);
    } finally {
      CONTROLS.positive.length = 0;
      CONTROLS.positive.push(...saved);
    }
    expect(controlFailures()).toEqual([]);
  });
});

describe('sweeping a seeded tree', () => {
  let root;

  const write = (rel, source) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuous-sweep-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports the vacuous file and leaves the sound one alone', () => {
    write('src/bad.test.ts', "it('asserts nothing', () => { const x = compute(); use(x); });");
    write('src/good.test.ts', "it('adds', () => { expect(add(1, 2)).toBe(3); });");

    const result = sweep(root);

    expect(result.files).toBe(2);
    expect(result.blocks).toBe(2);
    // The exact shape, not just "some candidates": a relative path, a real line, a non-empty hit list.
    expect(result.candidates).toEqual([
      { file: 'src/bad.test.ts', line: 1, title: 'asserts nothing', hits: ['NO-ASSERTION: block contains no assertion at all'] },
    ]);
  });

  it('reports the line the block is actually on', () => {
    write('a.test.ts', "// header\n\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n\nit('nothing', () => { use(x); });\n");
    expect(sweep(root).candidates.map((c) => c.line)).toEqual([5]);
  });

  it('screens .spec files too, which a .test-only walk reported as a clean repo', () => {
    write('e2e/smoke.spec.ts', "it('asserts nothing', () => { use(x); });");
    expect(sweep(root).files).toBe(1);
    expect(sweep(root).candidates).toHaveLength(1);
  });

  /** Zero files and a clean suite are the same output, so one of them has to be an error. */
  it('throws rather than reporting zeros when nothing was screened', () => {
    write('src/notes.md', 'no tests here');
    expect(() => sweep(root)).toThrow(/no test files/);
  });

  it('survives a dangling symlink instead of aborting the walk', () => {
    write('src/good.test.ts', "it('adds', () => { expect(add(1, 2)).toBe(3); });");
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'src', 'dangling'));

    expect(testFiles(root)).toHaveLength(1);
    expect(sweep(root).candidates).toEqual([]);
  });

  it('does not recurse into a self-referential symlinked directory', () => {
    write('src/good.test.ts', "it('adds', () => { expect(add(1, 2)).toBe(3); });");
    fs.symlinkSync(root, path.join(root, 'src', 'loop'));

    expect(testFiles(root)).toHaveLength(1);
  });
});
