import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Screens a repo's test files for assertions that CANNOT FAIL.
 *
 * Same shape as `repo-stats.mjs`, for the same reason: a broken screen reports a clean suite, so
 * "the tests are fine" and "I could not read the tests" are the same output. Every heuristic carries
 * a positive control and a negative control on the legitimate shape it most resembles;
 * `assertInstruments()` runs them before any result is produced; `sweep()` throws rather than
 * returning zeros when it finds no test files at all.
 *
 * Output is CANDIDATES, not findings — each needs a human read.
 *
 * **A control is only as good as the shapes it covers.** The first version passed all its controls
 * while silently dropping every JSX test, every tagged-template `it.each`, and every matcher-less
 * `expect` that was not the last statement in its block. The controls below name each of those.
 */

const HITS = {
  NO_ASSERTION: 'NO-ASSERTION: block contains no assertion at all',
  NO_MATCHER: 'NO-MATCHER: an expect(...) is not followed by a matcher',
  LITERAL: 'LITERAL: a literal asserted against a literal',
  EMPTY_LOOP: 'EMPTY-LOOP: every assertion sits inside a loop over a computed collection, with no length pinned',
};

/**
 * True where a `/` can only begin a regex.
 *
 * `<` and `>` are deliberately NOT here. They are regex positions in strict JS (`a < /re/.test(b)`),
 * and including them made `</div>` open a fake regex that blanked the rest of the line — which
 * deleted whole JSX test blocks from the sweep. A missed regex costs a false candidate; a swallowed
 * JSX line costs a silent false negative, and this file exists to avoid the second.
 */
export function isRegexPosition(before) {
  const trimmed = before.replace(/\s+$/, '');
  if (trimmed === '') return true;
  if (trimmed.endsWith('=>')) return true;
  if (/\b(return|typeof|case|in|of|do|else|delete|void|instanceof)$/.test(trimmed)) return true;
  return /[=(,:[!&|?+{;}*%^~-]/.test(trimmed.slice(-1));
}

/** Blanks the CONTENTS of comments, strings and regex literals, preserving every offset and newline. */
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
    if (c === '/' && isRegexPosition(out)) {
      // Scan ahead first: a regex that does not close on its own line was never a regex, and
      // consuming to end-of-line would eat a newline and shift every line number after it.
      const end = regexEnd(src, i);
      if (end !== -1) {
        out += '/' + ' '.repeat(end - i - 1) + '/';
        i = end + 1;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === c) break;
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += src[i] === undefined ? '' : c;
      i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Index of a regex literal's closing `/`, or -1 if it does not close on this line. */
function regexEnd(src, open) {
  let inClass = false;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '\n') return -1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
  }
  return -1;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function titleAt(src, openParen) {
  const quote = src[openParen + 1];
  if (quote !== '"' && quote !== "'" && quote !== '`') return '(dynamic)';
  const close = src.indexOf(quote, openParen + 2);
  return close === -1 ? '(dynamic)' : src.slice(openParen + 2, close).replace(/\s+/g, ' ').slice(0, 90);
}

/**
 * The lookbehind stops `/\.ts$/.test(entry)` — a method call — reading as a test block. The trailing
 * group allows a TS type argument, which `it.each<Case>([...])` uses.
 */
const OPENER = /(?<![.\w$])(it|test)\s*(\.\s*(each|only|skip|concurrent|todo|fails|runIf|skipIf)\b\s*)*(<[^(`]*>\s*)?[(`]/g;

export function testBlocks(src) {
  const stripped = stripNoise(src);
  const blocks = [];
  const opener = new RegExp(OPENER.source, 'g');
  let match;
  while ((match = opener.exec(stripped)) !== null) {
    let cursor = match.index + match[0].length - 1;
    // `it.each` takes its table as an array `([...])` OR as a tagged template `` `a|b` ``. Either
    // way the BLOCK is the call that follows the table; screening the table reads as assertion-free.
    if (stripped[cursor] === '`') {
      const close = stripped.indexOf('`', cursor + 1);
      if (close === -1) continue;
      const next = /^\s*\(/.exec(stripped.slice(close + 1));
      if (!next) continue;
      cursor = close + next[0].length;
    }
    let open = cursor;
    let close = matchingParen(stripped, open);
    if (close === -1) continue;
    if (/\.\s*each\b/.test(match[0]) && stripped[cursor] === '(') {
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
 * The parser as first written, preserved so a test can watch it lie — the `naiveAiCoAuthoredGrep`
 * precedent. It brace-matches an `it.each` table, is blind to regex literals, and has no lookbehind.
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
 * Deliberately wide: `expectTypeOf<A>()` is vitest's type assertion, `expectRefreshOnWrite(...)` is a
 * helper that asserts internally, and `throw new Error()` fails a test as surely as a matcher does.
 */
function hasAssertion(text) {
  return /\b(expect|assert)\w*\s*[(<]/.test(text) || /throw new /.test(text);
}

/** Every `expect(...)` not followed by `.something` — an assertion that cannot fail. */
export function matcherlessExpects(body) {
  const found = [];
  // NOT `.expect(` — supertest chains `await request(app).delete(url).expect(204)`, which asserts.
  for (const match of body.matchAll(/(?<![.\w$])expect\s*\(/g)) {
    const open = body.indexOf('(', match.index);
    const close = matchingParen(body, open);
    if (close === -1) continue;
    // Semicolons are not required: `expect(value)` on its own line is the same defect.
    if (!/^\s*\./.test(body.slice(close + 1))) found.push(body.slice(match.index, close + 1));
  }
  return found;
}

/** Pins on how many items a loop will see. Only meaningful OUTSIDE the loop bodies — see `screenBlock`. */
const LENGTH_PINNED = /toHaveLength|\.length\s*\)|\.size\s*\)|toBeGreaterThan|toEqual\(\s*\[/;

/**
 * A collection that could be empty at runtime.
 *
 * A bare identifier is a constant or a fixture the file controls (`ISSUE_STATES`); a literal array
 * cannot be empty by accident. Anything else — a call, or a member of something (`result.candidates`)
 * — is a value that a change elsewhere can empty out. The first version required a `(`, which let
 * `for (const c of result.candidates)` through; that was this probe's own vacuous test.
 */
function isComputed(source) {
  if (source.startsWith('[')) return false;
  return /[.(]/.test(source);
}

/** Every `for (… of …)` and `.forEach(…)` in the block, with the exact span of its body. */
export function loopsIn(body) {
  const loops = [];
  for (const match of body.matchAll(/for\s*\(\s*(?:const|let|var)\s/g)) {
    const open = body.indexOf('(', match.index);
    const close = matchingParen(body, open);
    if (close === -1) continue;
    const header = body.slice(open + 1, close);
    const of = /\sof\s/.exec(header);
    if (!of) continue;
    const after = body.slice(close + 1);
    const brace = /^\s*\{/.exec(after);
    let span;
    if (brace) {
      const bodyOpen = close + brace[0].length;
      const bodyClose = matchingBrace(body, bodyOpen);
      span = body.slice(bodyOpen, bodyClose === -1 ? body.length : bodyClose + 1);
    } else {
      // A braceless loop body is one statement — up to the first `;`, not 400 characters of whatever
      // follows, which attributed the NEXT statement's assertion to the loop.
      const semi = after.indexOf(';');
      span = semi === -1 ? after : after.slice(0, semi + 1);
    }
    loops.push({ iterable: header.slice(of.index + of[0].length).trim(), body: span, start: close + 1 });
  }
  for (const match of body.matchAll(/([\w.$\])]+)\s*\.forEach\s*\(/g)) {
    const open = body.indexOf('(', match.index + match[1].length);
    const close = matchingParen(body, open);
    if (close === -1) continue;
    loops.push({ iterable: match[1].trim(), body: body.slice(open, close + 1), start: open });
  }
  return loops;
}

export function screenBlock(block) {
  const hits = [];
  const { body } = block;

  if (!hasAssertion(body)) hits.push(HITS.NO_ASSERTION);
  if (matcherlessExpects(body).length > 0) hits.push(HITS.NO_MATCHER);

  // BOTH sides literal. `expect(720).toBeGreaterThan(page.height)` measures a constant against a
  // computed value and is a perfectly good assertion.
  if (/expect\s*\(\s*(true|false|-?\d+)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*(true|false|-?\d+)\s*\)/.test(body)) {
    hits.push(HITS.LITERAL);
  }

  /*
   * Fires only when EVERY assertion is inside a loop over a computed collection. An assertion outside
   * the loops means the block still asserts something unconditionally, and a length pin outside them
   * means the collection's size is nailed down — a pin written INSIDE the body says nothing about
   * whether the body runs, which is why `outside` is what gets tested rather than the whole block.
   */
  const loops = loopsIn(body);
  const asserting = loops.filter((loop) => hasAssertion(loop.body));
  if (asserting.length > 0 && asserting.some((loop) => isComputed(loop.iterable))) {
    let outside = body;
    for (const loop of loops) outside = outside.replace(loop.body, ' ');
    if (!hasAssertion(outside) && !LENGTH_PINNED.test(outside)) hits.push(HITS.EMPTY_LOOP);
  }

  return hits;
}

/**
 * The controls. Positives must fire; negatives must stay quiet on the legitimate shape each
 * heuristic most resembles; zero-block sources must parse to no test; one-block sources must parse to
 * exactly one — the category that would have caught the JSX and tagged-template bugs.
 */
export const CONTROLS = {
  positive: [
    ['no assertion', "it('does a thing', () => { const x = compute(); use(x); });", HITS.NO_ASSERTION],
    ['no matcher', "it('checks', () => { expect(value); });", HITS.NO_MATCHER],
    ['no matcher, no semicolon', "it('checks', () => { expect(value) })", HITS.NO_MATCHER],
    ['no matcher, followed by a good one', "it('checks', () => { expect(value); expect(other).toBe(1); });", HITS.NO_MATCHER],
    ['literal vs literal', "it('is fine', () => { expect(true).toBe(true); });", HITS.LITERAL],
    ['loop over a call result', "it('all match', () => { for (const v of collect(xs)) expect(v).toBe(1); });", HITS.EMPTY_LOOP],
    ['loop over a member of a result', "it('reports', () => { for (const c of result.candidates) { expect(c.ok).toBe(true); } });", HITS.EMPTY_LOOP],
    ['inner length assertion is not a pin', "it('one group', () => { for (const s of sections(x)) { expect(s.f.length).toBeGreaterThan(0); } });", HITS.EMPTY_LOOP],
  ],
  negative: [
    ['plain assertion', "it('adds', () => { expect(add(1, 2)).toBe(3); });"],
    ['it.each array table', "it.each([['a', 1]])('handles %s', (n, v) => { expect(f(n)).toBe(v); });"],
    ['regex with escaped parens', "it('parses', () => { const m = /CHECK \\(x IN \\(([^)]*)\\)\\)/.exec(sql); expect(m).not.toBeNull(); });"],
    ['throws instead of expecting', "it('shouts', () => { for (const x of xs) { if (bad(x)) throw new Error('nope'); } });"],
    ['literal vs computed', "it('is outside', () => { expect(720).toBeGreaterThan(page.height); });"],
    ['loop over a literal array', "it('both ways', () => { for (const p of [true, false]) expect(f(p)).toBe(true); });"],
    ['loop over a constant', "it('all states', () => { for (const s of ISSUE_STATES) expect(can(s)).toBe(false); });"],
    ['guarded loop', "it('all match', () => { const xs = q(); expect(xs).toHaveLength(3); for (const v of xs) expect(v).toBe(1); });"],
    ['accumulate then assert', "it('sums', () => { let n = 0; for (const x of compute(xs)) { n += x; } expect(n).toBe(3); });"],
    ['braces inside a string', "it('quotes', () => { expect(render()).toBe('a { b } c'); });"],
    ['asserts through a helper', "it('broadcasts', async () => { await expectRefreshOnWrite(dir, 'a.md', c); });"],
    ['vitest type assertion', "it('types match', () => { expectTypeOf<local.Ticket>().toEqualTypeOf<pkg.Ticket>(); });"],
    ['division, not a regex', "it('divides', () => { const half = total / 2; expect(half).toBe(3); });"],
    ['division after a call', "it('divides', () => { const r = width() / rows.length; expect(r).toBe(2); });"],
    ['jsx closing tag', "it('renders', () => { render(<div>{fmt(x)}</div>); expect(screen.getByText('a')).toBeVisible(); });"],
    ['supertest chained expect', "it('deletes', async () => { await request(app).delete(url).expect(204); expect(after()).toBe(0); });"],
  ],
  /** Sources that must parse to EXACTLY one block — a shape silently parsing to zero vanishes. */
  oneBlock: [
    ['plain it', "it('adds', () => { expect(1).toBe(1); });"],
    ['jsx in the body', "it('renders', () => { render(<div>{fmt(x)}</div>); expect(el).toBeVisible(); });"],
    ['it.each array table', "it.each([['a', 1]])('handles %s', (n, v) => { expect(f(n)).toBe(v); });"],
    ['it.each tagged template', "it.each`\n  a    | b\n  ${1} | ${2}\n`('adds $a', ({ a, b }) => { expect(a).toBe(b); });"],
    ['it.each with a type argument', "it.each<Case>([['a', 1]])('handles %s', (n, v) => { expect(f(n)).toBe(v); });"],
    ['multi-line jsx', "it('renders a row', () => {\n  const el = <div>{fmt(x)}</div>;\n  expect(el).toBeTruthy();\n});"],
  ],
  zeroBlock: [
    ['regex .test() method', 'const isTest = (rel) => /\\.test\\.ts$/.test(rel);'],
    ['member call named it', 'const x = obj.it(1);'],
  ],
};

export function controlFailures() {
  const failures = [];
  const single = (name, source) => {
    const blocks = testBlocks(source);
    if (blocks.length !== 1) { failures.push(`${name}: parsed ${blocks.length} blocks, expected 1`); return null; }
    return blocks[0];
  };
  for (const [name, source, expected] of CONTROLS.positive) {
    const block = single(`positive "${name}"`, source);
    if (block && !screenBlock(block).includes(expected)) failures.push(`positive "${name}": did not fire`);
  }
  for (const [name, source] of CONTROLS.negative) {
    const block = single(`negative "${name}"`, source);
    if (block) {
      const hits = screenBlock(block);
      if (hits.length > 0) failures.push(`negative "${name}": false positive ${JSON.stringify(hits)}`);
    }
  }
  for (const [name, source] of CONTROLS.oneBlock) single(`one-block "${name}"`, source);
  for (const [name, source] of CONTROLS.zeroBlock) {
    const count = testBlocks(source).length;
    if (count !== 0) failures.push(`zero-block "${name}": parsed ${count} blocks, expected 0`);
  }
  // Line numbers must survive stripping, or every reported location is wrong.
  const lined = "const el = <div>{x}</div>;\nit('t', () => { expect(1).toBe(1); });";
  if (stripNoise(lined).split('\n').length !== lined.split('\n').length) {
    failures.push('stripNoise: line count changed — reported line numbers would be wrong');
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

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
// `.claude` used to be skipped wholesale, which silently hid the four suites the
// repo relies on most — guard-bash, guard-ticket, track-steps and
// settings.audit. The thing that actually needs skipping is the nested full
// checkouts under `.claude/worktrees`, so the skip is by PATH, not by basename
// (`tkt-d88902f60f7c`).
const SKIP_PATH = [join('.claude', 'worktrees')];

export function testFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory — skip it rather than abort the sweep
    }
    for (const entry of entries) {
      if (SKIP_DIR.has(entry)) continue;
      const full = join(dir, entry);
      if (SKIP_PATH.some((suffix) => full.endsWith(suffix))) continue;
      // `lstat`, so a symlinked directory is not followed — a self-referential link would otherwise
      // recurse until the path blows up. `throwIfNoEntry` keeps a dangling link from ending the walk.
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (stat === undefined || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else if (TEST_FILE.test(entry)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

export function sweep(root = process.cwd()) {
  assertInstruments(); // controls run BEFORE any value is returned
  const files = testFiles(root);
  // Zero files is not a clean sweep — it is the same output as a clean sweep, which is the failure
  // this whole file is built to refuse. A mistyped path or a `.spec`-only repo lands here.
  if (files.length === 0) {
    throw new Error(`vacuous-tests: no test files under ${root} — nothing was screened. Refusing to report a clean sweep.`);
  }
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

// CLI — a broken instrument or an empty sweep throws here and exits non-zero.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(sweep(process.argv[2] ?? process.cwd()), null, 2));
}
