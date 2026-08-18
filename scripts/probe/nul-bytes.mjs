import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A probe for NUL bytes in a board's ticket files (tkt-0fc9ba1b86c2). A NUL is what makes a text
// file classify as binary, and a binary-skipping grep drops it — so one stray byte silently removes
// a ticket from a count without removing it from the board. The live board read 745 archived one
// way and 746 the other; the gap was invisible because both numbers look plausible. See
// `## Probe discipline` in CLAUDE.md.
//
// Read-only by design: it prints the fix rather than applying it, so editing a ticket body stays a
// deliberate act (the merged-branches.mjs precedent, which prints a paste-ready `git branch -D`).

const NUL = 0x00;
const EXCERPT_RADIUS = 60;

export function ticketsDir(boardRoot) {
  return path.join(boardRoot, 'tickets');
}

function ticketFiles(boardRoot) {
  const dir = ticketsDir(boardRoot);
  if (!fs.existsSync(dir)) return null; // distinct from "exists but empty" — assertInstruments splits them
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

// The loud control, called by every exported reader below rather than left to the caller: a probe
// that scanned nothing must never answer "clean". That is the fail-open shape this repo rejects —
// "can't check" returning the permissive answer.
export function assertInstruments(boardRoot) {
  const files = ticketFiles(boardRoot);
  if (files === null) {
    throw new Error(`nul-bytes: no tickets/ directory under ${boardRoot} — cannot scan, refusing to report a clean board.`);
  }
  if (files.length === 0) {
    throw new Error(`nul-bytes: scanned 0 ticket files under ${ticketsDir(boardRoot)} — an empty scan is not a clean board.`);
  }
  return files;
}

// A byte slice cut at a fixed radius can land mid-character, and the U+FFFD it decodes to is
// indistinguishable from real corruption — the wrong ambiguity to add to a report about invisible
// bytes. Walk both edges off UTF-8 continuation bytes (0b10xxxxxx) so the window is whole characters.
function charBoundary(buf, index, limit) {
  let i = index;
  while (i > 0 && i < limit && (buf[i] & 0xc0) === 0x80) i += 1;
  return i;
}

function excerptAt(buf, offset) {
  const start = charBoundary(buf, Math.max(0, offset - EXCERPT_RADIUS), buf.length);
  const end = charBoundary(buf, Math.min(buf.length, offset + EXCERPT_RADIUS), buf.length);
  return buf.subarray(start, end).toString('utf8').replaceAll('\0', '⟦NUL⟧').replaceAll('\n', '⏎');
}

export function scanBoard(boardRoot) {
  const files = assertInstruments(boardRoot);

  const findings = [];
  for (const file of files) {
    // Read as BYTES. Decoding to a string first is the bug this probe exists to catch: a lossy
    // decode can substitute or drop the very byte being looked for.
    const buf = fs.readFileSync(path.join(ticketsDir(boardRoot), file));
    const offsets = [];
    for (let i = buf.indexOf(NUL); i !== -1; i = buf.indexOf(NUL, i + 1)) offsets.push(i);
    if (offsets.length > 0) {
      findings.push({ file, offsets, excerpts: offsets.map((o) => excerptAt(buf, o)) });
    }
  }
  return { scanned: files.length, findings };
}

// Counts ticket files matching `pattern`, twice over, so the test can watch the two disagree — the
// divergence IS the finding. `binarySafe: true` forces text (`-a`) and is the correct instrument;
// `false` passes `-I` to reproduce the count that hid the defect.
//
// `-I`, not bare grep, is the faithful model: plain grep(1) DOES list a NUL-bearing file. What
// under-reported on the live board was the session shell's `grep`, a shim that execs ugrep with
// `-G --ignore-files --hidden -I …` — the `-I` drops binary files, and `--ignore-files` separately
// drops gitignored ones. Anything ripgrep-shaped skips binary by default too. So the hazard is the
// wrapper (and any interactive shell like it), not grep itself.
//
// `binarySafe` is REQUIRED: defaulting it would make the under-reporting instrument the one a
// caller gets by omitting an argument, which is this module's own bug served back as an API.
export function countMatchingFiles(boardRoot, pattern, options) {
  if (typeof options?.binarySafe !== 'boolean') {
    throw new TypeError('nul-bytes: countMatchingFiles requires an explicit { binarySafe: boolean } — there is no safe default.');
  }
  const files = assertInstruments(boardRoot);
  const args = ['-l', options.binarySafe ? '-a' : '-I', pattern, ...files];
  try {
    // execFile, not a shell: going through the shell would resolve that same wrapper and measure it
    // instead of grep(1), which is the confound this whole function exists to isolate.
    const out = execFileSync('grep', args, { cwd: ticketsDir(boardRoot), encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  } catch (err) {
    if (err.status === 1) return 0; // grep(1): exit 1 means "no lines selected", not an error
    throw err;
  }
}

// POSIX single-quote escaping. Without it a path holding an apostrophe closes the quote early, so
// the "paste-ready" command is malformed — and with a hostile path it is an injection shape.
function shQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatReport(boardRoot, { scanned, findings }) {
  if (findings.length === 0) return `nul-bytes: no NUL bytes in ${scanned} ticket file(s) under ${boardRoot}.`;

  const lines = [`nul-bytes: ${findings.length} of ${scanned} ticket file(s) under ${boardRoot} contain a NUL byte.`, ''];
  for (const { file, offsets, excerpts } of findings) {
    lines.push(`  ${file} — offset(s) ${offsets.join(', ')}`);
    for (const excerpt of excerpts) lines.push(`      ${excerpt}`);
  }
  lines.push('', 'Each is invisible to a binary-skipping grep, so such counts under-report by that many.');
  lines.push('Inspect the excerpt first — the intended text is usually a two-character `\\0` escape — then strip with:');
  for (const { file } of findings) {
    const p = shQuote(path.join(ticketsDir(boardRoot), file));
    lines.push(`  tr -d '\\000' < ${p} > ${p}.tmp && mv ${p}.tmp ${p}`);
  }
  return lines.join('\n');
}

// Compare REAL paths, and tolerate a missing argv[1]: without the realpath the CLI silently does
// nothing when invoked through a symlink (exit 0 with no output — a fail-open reading from a probe
// that never ran), and a bare `path.resolve(undefined)` throws on `import()`. Both already shipped
// once here — see clean-room.test.mjs's symlink case (tkt-b86d2a318f8b).
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// CLI — `node scripts/probe/nul-bytes.mjs [boardRoot]`. Takes any board's path so it runs against
// another repo's board too (the vacuous-tests.mjs precedent). Exit 1 = findings, 2 = could not scan.
// `process.exitCode`, never `process.exit()`: the latter drops pending stdout writes on a pipe, so a
// long report is truncated mid-line — a probe against silent under-reporting, under-reporting
// silently (merged-branches.test.mjs pins the same rule on its own source).
if (isMainModule()) {
  const boardRoot = path.resolve(process.argv[2] ?? process.env.BOARD_DIR_OVERRIDE ?? process.cwd());
  try {
    const result = scanBoard(boardRoot);
    console.log(formatReport(boardRoot, result));
    process.exitCode = result.findings.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
