import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Screens a repo's test files for assertions that CANNOT FAIL.
 *
 * Same shape as `repo-stats.mjs`, for the same reason: a broken screen reports a clean suite, and
 * "the tests are fine" and "I could not measure the tests" are then the same output. Every heuristic
 * carries a positive and a negative control, `assertInstruments()` runs them before any result is
 * produced, and the parser bugs that made the first hand-run lie are reconstructed in
 * `naiveTestBlocks` so a test can watch the broken version fail.
 *
 * Output is CANDIDATES, not findings. Each one needs a human read — the sweep of equipment-schedule
 * that motivated this returned ten, of which most were legitimate code.
 */

const HITS = {
  NO_ASSERTION: 'NO-ASSERTION: block contains no assertion at all',
  NO_MATCHER: 'NO-MATCHER: an expect(...) is not followed by a matcher',
  LITERAL: 'LITERAL: a literal asserted against a literal',
  EMPTY_LOOP: 'EMPTY-LOOP: assertions run only inside a loop over a computed collection, with no length pinned',
};

/**
 * Blanks out the CONTENTS of comments, strings and regex literals, preserving offsets and newlines.
 *
 * Regex literals matter more than they look: `/CHECK \(state\)/` carries escaped parens, and a paren
 * counter that treats them as real ends the block early — which reported twelve assertion-bearing
 * tests as having none.
 */
/** True where a `/` can only begin a regex: after an operator, a separator, or a keyword. */
export function isRegexPosition(before) {
  const trimmed = before.replace(/\s+$/, '');
  if (trimmed === '') return true;
  if (trimmed.endsWith('=>')) return true;
  if (/\b(return|typeof|case|in|of|do|else|delete|void|instanceof)$/.test(trimmed)) return true;
  return /[=(,:[!&|?+{;}*%^~<>-]/.test(trimmed.slice(-1));
}

export function stripNoise(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    // A `/` is a regex only where a VALUE may start — otherwise it is division. Decided by the last
    // non-space character, not by whether the set appears nearby: `const half = total / 2` has an `=`
    // seven characters back, and matching on that ate the rest of the line.
    if (c === '/' && isRegexPosition(out)) {
      out += '/'; i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '\n') break;
        else if (src[i] === '/' && !inClass) break;
        out += ' '; i++;
      }
      out += '/'; i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === c) break;
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += c; i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function titleAt(src, openParen) {
  const quote = src[openParen + 1];
  if (quote !== '"' && quote !== "'" && quote !== '`') return '(dynamic)';
  const close = src.indexOf(quote, openParen + 2);
  if (close === -1) return '(dynamic)';
  return src.slice(openParen + 2, close).replace(/\s+/g, ' ').slice(0, 90);
}

/** The lookbehind is what stops `/\.ts$/.test(entry)` — a method call — being read as a test block. */
const OPENER = /(?<![.\w$])(it|test)\s*(\.\s*(each|only|skip|concurrent|todo|fails|runIf|skipIf)\b\s*)*\(/g;

export function testBlocks(src) {
  const stripped = stripNoise(src);
  const blocks = [];
  const opener = new RegExp(OPENER.source, 'g');
  let match;
  while ((match = opener.exec(stripped)) !== null) {
    let open = match.index + match[0].length - 1;
    let close = matchingParen(stripped, open);
    if (close === -1) continue;
    // `it.each([...])('title', fn)`: the first group is the TABLE, which holds no assertions. Screen
    // the call that follows it, or every parameterised test reads as assertion-free.
    if (/\.\s*each\b/.test(match[0])) {
      const next = /^\s*\(/.exec(stripped.slice(close + 1));
      if (next) {
        open = close + next[0].length;
        close = matchingParen(stripped, open);
        if (close === -1) continue;
      }
    }
    blocks.push({
      title: titleAt(src, open),
      body: stripped.slice(open, close + 1),
      line: src.slice(0, open).split('\n').length,
    });
    opener.lastIndex = close;
  }
  return blocks;
}

/**
 * The parser as first written, preserved so a test can watch it lie.
 *
 * Three of the four bugs live here: it brace-matches an `it.each` table, is blind to regex literals,
 * and has no lookbehind so `.test(` counts as a test block. `repo-stats.mjs` keeps
 * `naiveAiCoAuthoredGrep` for the same purpose — a reconstruction that goes red is proof; a comment
 * saying "this used to be wrong" is not.
 */
export function naiveTestBlocks(src) {
  const stripped = src.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  const blocks = [];
  const opener = /\b(it|test)\s*(\.\s*\w+\s*)?\(/g;
  let match;
  while ((match = opener.exec(stripped)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(stripped, open);
    if (close === -1) continue;
    blocks.push({ title: titleAt(src, open), body: stripped.slice(open, close + 1), line: 0 });
    opener.lastIndex = close;
  }
  return blocks;
}

/**
 * Anything in the block that pins how many items a loop will see.
 *
 * Crude by design, and it errs toward NOT suppressing: a pin anywhere in the block counts, which can
 * miss a candidate, so the set stays small. `.size)` was in here briefly and swallowed a real one —
 * `expect(new Set(section.fields.map(...)).size).toBe(1)` sits INSIDE the loop body and says nothing
 * about whether the loop runs at all.
 */
const LENGTH_PINNED = /toHaveLength|\.length\s*\)|toBeGreaterThan|toEqual\(\s*\[/;

/** Iterables that cannot be empty: a literal array, or a bare identifier (a constant, not a result). */
function computedIterables(body) {
  const found = [];
  for (const match of body.matchAll(/for\s*\(\s*(?:const|let)\s/g)) {
    const open = body.indexOf('(', match.index);
    const close = matchingParen(body, open);
    if (close === -1) continue;
    const header = body.slice(open + 1, close);
    const of = /\sof\s/.exec(header);
    if (!of) continue;
    // Only a loop whose OWN body asserts — a later assertion in the block is not this loop's.
    if (!/^\s*(\{[\s\S]*?expect\(|expect\()/.test(body.slice(close + 1, close + 400))) continue;
    found.push(header.slice(of.index + of[0].length).trim());
  }
  for (const match of body.matchAll(/([\w.$\])]+)\s*\.forEach\(\s*\(?[^)]*\)?\s*=>\s*\{?\s*expect\(/g)) {
    found.push(match[1].trim());
  }
  return found.filter((source) => /\(/.test(source) && !source.startsWith('['));
}

export function screenBlock(block) {
  const hits = [];
  const { body } = block;

  /*
   * Deliberately wide. `expectTypeOf<A>()` is vitest's type assertion, `expectRefreshOnWrite(...)` is
   * a helper that asserts inside itself, and `throw new Error(...)` fails a test as surely as a
   * matcher does. A narrow `expect(` check called all three assertion-free — and a screen that cries
   * wolf on legitimate code gets ignored, which is the same end state as not running it.
   */
  if (!/\b(expect|assert)\w*\s*[(<]/.test(body) && !/throw new /.test(body)) {
    hits.push(HITS.NO_ASSERTION);
  }
  if (/expect\s*\([^;]*\)\s*;/.test(body.replace(/expect\s*\([\s\S]*?\)\s*\./g, 'X.'))) {
    hits.push(HITS.NO_MATCHER);
  }
  // BOTH sides literal. `expect(720).toBeGreaterThan(page.height)` measures a constant against a
  // computed value and is a perfectly good assertion.
  if (/expect\s*\(\s*(true|false|-?\d+)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*(true|false|-?\d+)\s*\)/.test(body)) {
    hits.push(HITS.LITERAL);
  }
  if (computedIterables(body).length > 0 && !LENGTH_PINNED.test(body)) {
    hits.push(HITS.EMPTY_LOOP);
  }
  return hits;
}

/**
 * The controls. Positives must fire, negatives must stay quiet on the legitimate shape each
 * heuristic most resembles, and zero-block sources must parse to no test at all.
 */
export const CONTROLS = {
  positive: [
    ['no assertion', "it('does a thing', () => { const x = compute(); use(x); });", HITS.NO_ASSERTION],
    ['no matcher', "it('checks', () => { expect(value); });", HITS.NO_MATCHER],
    ['literal vs literal', "it('is fine', () => { expect(true).toBe(true); });", HITS.LITERAL],
    ['loop over a computed collection', "it('all match', () => { for (const v of collect(xs)) expect(v).toBe(1); });", HITS.EMPTY_LOOP],
    // An inner `.size` assertion is not a pin on the loop's own collection.
    ['inner size assertion is not a pin', "it('one group', () => { for (const s of sections(x)) { expect(new Set(s.f).size).toBe(1); } });", HITS.EMPTY_LOOP],
  ],
  negative: [
    ['plain assertion', "it('adds', () => { expect(add(1, 2)).toBe(3); });"],
    ['it.each table', "it.each([['a', 1]])('handles %s', (n, v) => { expect(f(n)).toBe(v); });"],
    ['regex with escaped parens', "it('parses', () => { const m = /CHECK \\(x IN \\(([^)]*)\\)\\)/.exec(sql); expect(m).not.toBeNull(); });"],
    ['throws instead of expecting', "it('shouts', () => { for (const x of xs) { if (bad(x)) throw new Error('nope'); } });"],
    ['literal vs computed', "it('is outside', () => { expect(720).toBeGreaterThan(page.height); });"],
    ['loop over a literal array', "it('both ways', () => { for (const p of [true, false]) expect(f(p)).toBe(true); });"],
    ['loop over a constant', "it('all states', () => { for (const s of ISSUE_STATES) expect(can(s)).toBe(false); });"],
    ['guarded loop', "it('all match', () => { const xs = q(); expect(xs).toHaveLength(3); for (const v of xs) expect(v).toBe(1); });"],
    ['braces inside a string', "it('quotes', () => { expect(render()).toBe('a { b } c'); });"],
    ['asserts through a helper', "it('broadcasts', async () => { await expectRefreshOnWrite(dir, 'a.md', c); });"],
    ['vitest type assertion', "it('types match', () => { expectTypeOf<local.Ticket>().toEqualTypeOf<pkg.Ticket>(); });"],
    ['division, not a regex', "it('divides', () => { const half = total / 2; expect(half).toBe(3); });"],
    ['division after a call', "it('divides', () => { const r = width() / rows.length; expect(r).toBe(2); });"],
  ],
  zeroBlock: [
    ['regex .test() method', 'const isTest = (rel) => /\\.test\\.ts$/.test(rel);'],
    ['member call named it', 'const x = obj.it(1);'],
  ],
};

export function controlFailures() {
  const failures = [];
  for (const [name, source, expected] of CONTROLS.positive) {
    const blocks = testBlocks(source);
    if (blocks.length !== 1) { failures.push(`positive "${name}": parsed ${blocks.length} blocks, expected 1`); continue; }
    if (!screenBlock(blocks[0]).includes(expected)) failures.push(`positive "${name}": did not fire`);
  }
  for (const [name, source] of CONTROLS.negative) {
    const blocks = testBlocks(source);
    if (blocks.length !== 1) { failures.push(`negative "${name}": parsed ${blocks.length} blocks, expected 1`); continue; }
    const hits = screenBlock(blocks[0]);
    if (hits.length > 0) failures.push(`negative "${name}": false positive ${JSON.stringify(hits)}`);
  }
  for (const [name, source] of CONTROLS.zeroBlock) {
    const count = testBlocks(source).length;
    if (count !== 0) failures.push(`zero-block "${name}": parsed ${count} blocks, expected 0`);
  }
  return failures;
}

export function assertInstruments() {
  const failures = controlFailures();
  if (failures.length > 0) {
    throw new Error(
      `vacuous-tests: ${failures.length} control(s) failed — the screen is broken, not the suite. ` +
      'Refusing to report a clean sweep.\n  ' + failures.join('\n  '),
    );
  }
}

const TEST_FILE = /\.test\.(ts|tsx|js|jsx|mjs)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.claude']);

export function testFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIR.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (TEST_FILE.test(entry)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

export function sweep(root = process.cwd()) {
  assertInstruments(); // controls run BEFORE any value is returned
  const files = testFiles(root);
  const candidates = [];
  let blocks = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const block of testBlocks(source)) {
      blocks++;
      const hits = screenBlock(block);
      if (hits.length > 0) candidates.push({ file: relative(root, file), line: block.line, title: block.title, hits });
    }
  }
  return { files: files.length, blocks, candidates };
}

// CLI — a broken instrument throws here and exits non-zero, rather than printing an empty sweep.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(sweep(process.argv[2] ?? process.cwd()), null, 2));
}
