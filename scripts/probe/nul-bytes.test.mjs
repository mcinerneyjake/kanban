import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  scanBoard, countMatchingFiles, assertInstruments, formatReport,
} from './nul-bytes.mjs';

// tkt-0fc9ba1b86c2. The defect this file pins: a ticket body may legitimately be handed a raw NUL
// (an implementation summary describing SQLite's `SQLite format 3\0` header wrote the byte instead
// of the escape), the writer persists it faithfully, and NOTHING reports it — while a
// binary-skipping grep silently drops that file from every count.

const CLI = fileURLToPath(new URL('./nul-bytes.mjs', import.meta.url));

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-probe-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function board(files, root = tmp) {
  const dir = path.join(root, 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return root;
}
const ticket = (status, body) => `---\ntitle: t\nstatus: ${status}\n---\n\n${body}\n`;
const withNul = (before, after = '` escape\n') =>
  Buffer.concat([Buffer.from(before), Buffer.from([0x00]), Buffer.from(after)]);

describe('scanBoard', () => {
  it('flags the file holding a NUL and names the byte offset', () => {
    const root = board({
      'tkt-clean1.md': ticket('archived', 'ordinary body'),
      'tkt-dirty.md': withNul(ticket('archived', 'respelled the constant as a `')),
      'tkt-clean2.md': ticket('todo', 'another body'),
    });

    const { scanned, findings } = scanBoard(root);

    expect(scanned).toBe(3);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('tkt-dirty.md');
    // The offset must actually point at the byte — an off-by-one here would send a human editing
    // the wrong character, which is the whole value the probe claims to add.
    const raw = fs.readFileSync(path.join(root, 'tickets', 'tkt-dirty.md'));
    expect(findings[0].offsets).toHaveLength(1);
    expect(raw[findings[0].offsets[0]]).toBe(0x00);
  });

  it('reports every occurrence when one file holds several', () => {
    const root = board({ 'tkt-many.md': Buffer.concat([withNul('a'), withNul('b'), Buffer.from('c')]) });
    expect(scanBoard(root).findings[0].offsets).toHaveLength(2);
  });

  // Negative control: absence must mean absence, not a matcher that never fires.
  it('reports nothing on a board with no NUL bytes', () => {
    const root = board({
      'tkt-a.md': ticket('archived', 'plain'),
      'tkt-b.md': ticket('done', 'also plain — with unicode: café … ✅ and a literal \\0 escape'),
    });

    const { scanned, findings } = scanBoard(root);

    expect(scanned).toBe(2);
    expect(findings).toEqual([]);
  });

  it('does not mistake a two-character \\0 escape for a raw NUL', () => {
    const root = board({ 'tkt-esc.md': ticket('done', 'the constant is `\\0` here') });
    expect(scanBoard(root).findings).toEqual([]);
  });

  // Finding #4: returning {scanned: 0, findings: []} here renders as "no NUL bytes in 0 files",
  // a clean-looking report for a board that was never read.
  it('throws rather than returning a clean result for an unscannable board', () => {
    expect(() => scanBoard(path.join(tmp, 'not-a-board'))).toThrow(/cannot scan/i);
    expect(() => scanBoard(board({}))).toThrow(/scanned 0 ticket files/i);
  });

  it('renders a multibyte character at the window edge without corruption markers', () => {
    // A ✅ straddling the excerpt boundary decoded to U+FFFD before the boundary walk, which is
    // indistinguishable from real corruption in a report whose subject is invisible bytes.
    const root = board({ 'tkt-wide.md': withNul(`${'✅'.repeat(40)}tail`) });
    expect(scanBoard(root).findings[0].excerpts[0]).not.toMatch(/�/);
  });
});

describe('countMatchingFiles — the divergence that hid the defect', () => {
  // The real-world symptom, reproduced: 745 vs 746 archived on the live board. The under-reporting
  // instrument is `-I` (the session shell's grep shim execs ugrep with it), NOT plain grep(1),
  // which lists a NUL-bearing file happily — verified against the live file before pinning it here.
  it('under-reports by exactly one when a matching file contains a NUL, unless binary-safe', () => {
    const root = board({
      'tkt-1.md': ticket('archived', 'one'),
      'tkt-2.md': ticket('archived', 'two'),
      'tkt-3.md': Buffer.concat([Buffer.from(ticket('archived', 'three')), Buffer.from([0x00])]),
    });

    const blind = countMatchingFiles(root, '^status: archived', { binarySafe: false });
    const safe = countMatchingFiles(root, '^status: archived', { binarySafe: true });

    expect(safe).toBe(3);
    expect(blind).toBe(2);
    expect(safe - blind).toBe(1);
  });

  it('agrees with the binary-safe count when no file holds a NUL', () => {
    const root = board({
      'tkt-1.md': ticket('archived', 'one'),
      'tkt-2.md': ticket('archived', 'two'),
    });
    expect(countMatchingFiles(root, '^status: archived', { binarySafe: false }))
      .toBe(countMatchingFiles(root, '^status: archived', { binarySafe: true }));
  });

  it('returns 0 for a pattern nothing matches, rather than throwing on grep exit 1', () => {
    const root = board({ 'tkt-1.md': ticket('todo', 'x') });
    expect(countMatchingFiles(root, '^status: nonexistent', { binarySafe: true })).toBe(0);
  });

  // Finding #3: an omitted option must not silently select the under-reporting instrument.
  it('refuses to run without an explicit binarySafe', () => {
    const root = board({ 'tkt-1.md': ticket('archived', 'x') });
    expect(() => countMatchingFiles(root, '^status:')).toThrow(/explicit \{ binarySafe/);
    expect(() => countMatchingFiles(root, '^status:', {})).toThrow(/explicit \{ binarySafe/);
    expect(() => countMatchingFiles(root, '^status:', { binarysafe: true })).toThrow(/explicit \{ binarySafe/);
  });

  it('refuses to count against an unscannable board', () => {
    expect(() => countMatchingFiles(path.join(tmp, 'nope'), 'x', { binarySafe: true })).toThrow(/cannot scan/i);
  });
});

describe('assertInstruments — "can\'t check" must not return the permissive answer', () => {
  it('throws rather than reporting a clean board when it scanned no files at all', () => {
    expect(() => assertInstruments(board({}))).toThrow(/scanned 0 ticket files/i);
  });

  it('throws when the board directory does not exist', () => {
    expect(() => assertInstruments(path.join(tmp, 'nope'))).toThrow(/cannot scan/i);
  });

  it('returns the file list on a board that does have ticket files', () => {
    expect(assertInstruments(board({ 'tkt-a.md': ticket('todo', 'x') }))).toEqual(['tkt-a.md']);
  });
});

describe('CLI', () => {
  const run = (args, opts = {}) => {
    try {
      return { status: 0, out: execFileSync('node', args, { encoding: 'utf8', ...opts }) };
    } catch (err) {
      // `err.status` is null/undefined when the spawn itself failed. Surfacing it as -1 keeps a
      // never-ran CLI from satisfying a `not.toBe(0)` assertion.
      return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it('exits 1 and prints a paste-ready fix when a NUL is found', () => {
    const root = board({ 'tkt-dirty.md': withNul(ticket('done', 'x')) });
    const { status, out } = run([CLI, root]);
    expect(status).toBe(1);
    expect(out).toMatch(/tkt-dirty\.md/);
    expect(out).toMatch(/tr -d/);
  });

  it('exits 0 and says so on a clean board', () => {
    const { status, out } = run([CLI, board({ 'tkt-a.md': ticket('todo', 'x') })]);
    expect(status).toBe(0);
    expect(out).toMatch(/no NUL bytes/i);
  });

  // Finding #5: `not.toBe(0)` could not tell 2 ("could not scan") from 1 ("findings"), which is
  // the one distinction the exit-code contract exists to make.
  it('exits exactly 2, with a reason on stderr, on a board it could not scan', () => {
    const { status, out } = run([CLI, path.join(tmp, 'missing')]);
    expect(status).toBe(2);
    expect(out).toMatch(/cannot scan, refusing to report a clean board/i);
  });

  it('exits exactly 2 on a board directory that exists but holds no tickets', () => {
    expect(run([CLI, board({})]).status).toBe(2);
  });

  // Finding #2a: without realpath on both sides this printed nothing and exited 0 — a probe that
  // never ran, reporting success.
  it('still runs when invoked through a symlink', () => {
    const link = path.join(tmp, 'linked-probe.mjs');
    fs.symlinkSync(CLI, link);
    const { status, out } = run([link, board({ 'tkt-dirty.md': withNul(ticket('done', 'x')) })]);
    expect(status).toBe(1);
    expect(out).toMatch(/tkt-dirty\.md/);
  });

  // Finding #2b: `path.resolve(process.argv[1])` threw ERR_INVALID_ARG_TYPE with no argv[1].
  it('can be imported without an argv[1] present', () => {
    const url = new URL('./nul-bytes.mjs', import.meta.url).href;
    const { status, out } = run(['-e', `import(${JSON.stringify(url)}).then(() => console.log('imported'))`]);
    expect(status).toBe(0);
    expect(out).toMatch(/imported/);
  });

  it('handles a board path containing spaces and an apostrophe', () => {
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), "nul probe's "));
    try {
      const { status, out } = run([CLI, board({ 'tkt-dirty.md': withNul(ticket('done', 'x')) }, odd)]);
      expect(status).toBe(1);
      // The emitted command must survive a shell round-trip: `sh -c` echoing it back yields the
      // real path, which a naively quoted apostrophe would break.
      const fix = out.split('\n').find((l) => l.includes('tr -d'));
      const quoted = fix.match(/< (.+?) > /)[1]; // the read target, not the `'\000'` argument
      expect(execFileSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' }))
        .toContain("nul probe's");
    } finally {
      fs.rmSync(odd, { recursive: true, force: true });
    }
  });

  // Finding #1: process.exit() drops pending stdout on a pipe, truncating a long report mid-line.
  // The sibling probe pins the same rule on its own source (merged-branches.test.mjs).
  it('does not call process.exit(), which would truncate the report through a pipe', () => {
    // Strip comments first: the rule is about the CALL, and the source explains the rule in prose
    // that names it. Matching raw text would pin the comment, not the behaviour.
    const code = fs.readFileSync(CLI, 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/process\.exitCode/); // control: the replacement IS present
    expect(code).not.toMatch(/process\.exit\(/);
  });

  it('writes a large report through a pipe without truncation', () => {
    const files = {};
    for (let i = 0; i < 400; i += 1) files[`tkt-${String(i).padStart(4, '0')}.md`] = withNul(ticket('done', 'x'));
    const root = board(files);
    const piped = execFileSync('sh', ['-c', `node ${JSON.stringify(CLI)} ${JSON.stringify(root)} | cat; exit 0`], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    // Assert COMPLETENESS, not a byte count: each fix line embeds the board's absolute path four
    // times, so total size tracks tmpdir length — 166KB on macOS, 117KB on CI's short /tmp. Pinning
    // a size measured the machine, not the behaviour, and went red in CI while passing locally.
    expect(piped.length).toBeGreaterThan(65536); // non-vacuity control: must exceed one pipe buffer
    expect(piped.split('\n').filter((l) => l.startsWith('  tr -d ')).length).toBe(400);
    // The final line must be the LAST file's complete fix command — a truncating exit cut mid-line.
    expect(piped.trimEnd().split('\n').pop()).toMatch(/tkt-0399\.md'$/);
  });
});

describe('formatReport', () => {
  it('renders the offset and a readable excerpt with the byte marked', () => {
    const report = formatReport('/board', {
      scanned: 2,
      findings: [{ file: 'tkt-x.md', offsets: [12], excerpts: ['as a `⟦NUL⟧` escape'] }],
    });
    expect(report).toMatch(/tkt-x\.md/);
    expect(report).toMatch(/12/);
    expect(report).toMatch(/⟦NUL⟧/);
  });

  it('single-quote-escapes a path holding an apostrophe', () => {
    const report = formatReport("/tmp/Jake's board", {
      scanned: 1,
      findings: [{ file: 'tkt-x.md', offsets: [0], excerpts: [''] }],
    });
    expect(report).toContain(`'/tmp/Jake'\\''s board/tickets/tkt-x.md'`);
  });
});
