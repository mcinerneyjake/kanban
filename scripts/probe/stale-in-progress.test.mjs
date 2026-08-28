import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseTicket, hasIntent, intentMatch, classify } from './stale-in-progress.mjs';

// tkt-3d25ae0626c6. What this file pins is the probe's EXIT-CODE CONTRACT, because §15 of the
// kanban-workflow skill now runs it at close time and reads its output. The failure that matters is
// not a wrong count — it is the probe reporting a clean board from a run that never scanned one.
// Every "cannot scan" path below must therefore exit 2, never 0.

const CLI = fileURLToPath(new URL('./stale-in-progress.mjs', import.meta.url));
const NOW = Date.parse('2026-08-28T00:00:00Z');

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-probe-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function board(files, root = tmp) {
  const dir = path.join(root, 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return root;
}

const ticket = ({ id = 'tkt-000000000001', status = 'in-progress', updated = '2026-01-01T00:00:00Z', blockers = [], body = 'Nothing here.' } = {}) =>
  `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nproject: kanban\nupdated: '${updated}'\n`
  + (blockers.length ? `blockers:\n${blockers.map((b) => `  - ${b}`).join('\n')}\n` : '')
  + `---\n${body}\n`;

// `err.status` is null when the spawn itself failed; -1 keeps that distinguishable from a real 0.
// process.execPath, not PATH's `node`: on this machine node is x86_64 under Rosetta, so the two can
// genuinely differ, and an absent PATH node would surface as a misleading assertion rather than a
// clear spawn error (merged-branches.test.mjs uses the same).
function run(args) {
  try {
    return { status: 0, out: execFileSync(process.execPath, args, { encoding: 'utf8' }) };
  } catch (err) {
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('exit-code contract', () => {
  it('exits 0 and says so when every in-progress ticket is accounted for', () => {
    const root = board({
      'tkt-000000000001.md': ticket({ body: 'Status stays `in-progress` — awaiting hardware.' }),
      'tkt-000000000002.md': ticket({ id: 'tkt-000000000002', status: 'done' }),
    });
    const { status, out } = run([CLI, root]);
    expect(status).toBe(0);
    expect(out).toMatch(/All 1 in-progress tickets are accounted for/);
  });

  it('exits 1 and prints the ticket\'s own words when one is unaccounted', () => {
    const root = board({
      'tkt-000000000001.md': ticket({ body: 'A body that states no reason at all.' }),
    });
    const { status, out } = run([CLI, root]);
    expect(status).toBe(1);
    expect(out).toMatch(/FLAG tkt-000000000001/);
    // The load-bearing design rule: a body tail, not a verdict. Without this the probe becomes the
    // very instrument it was built to replace.
    expect(out).toMatch(/A body that states no reason at all\./);
    expect(out).toMatch(/READ THESE, do not act on the flag/);
  });

  // The two fail-closed paths. A probe that cannot scan must never return the permissive answer:
  // "no board here" and "a clean board" are the one distinction this contract exists to make.
  it('exits exactly 2, with a reason on stderr, when there is no tickets/ directory', () => {
    const { status, out } = run([CLI, path.join(tmp, 'nowhere')]);
    expect(status).toBe(2);
    expect(out).toMatch(/refusing to report a clean board/);
  });

  it('exits exactly 2 when tickets/ exists but holds no ticket files', () => {
    const { status, out } = run([CLI, board({})]);
    expect(status).toBe(2);
    expect(out).toMatch(/an empty scan is not a clean board/);
  });

  it('exits 1 on blocker link-rot, rather than reading a missing blocker as blocked', () => {
    const root = board({
      'tkt-000000000001.md': ticket({ blockers: ['tkt-ffffffffffff'] }),
    });
    const { status, out } = run([CLI, root]);
    expect(status).toBe(1);
    expect(out).toMatch(/blocker link-rot/);
    expect(out).toMatch(/tkt-ffffffffffff/);
  });

  // An unreadable file means the scan was PARTIAL — every count above under-reports — so it belongs
  // with the cannot-scan cases in 2, not in the advisory bucket §15 tells sessions to expect. Folded
  // into exit 1, one permanently-corrupt archived ticket would make the audit a constant no-signal
  // alarm on a board whose in-progress tickets are all fine.
  it('exits 2, not 1, on an unreadable ticket file, and names it as absent from the counts', () => {
    const root = board({
      'tkt-000000000001.md': ticket({ body: 'Status stays `in-progress`.' }),
      'tkt-000000000009.md': 'no frontmatter at all\n',
    });
    const { status, out } = run([CLI, root]);
    expect(status).toBe(2);
    expect(out).toMatch(/UNREADABLE \(absent from every count above\)/);
    expect(out).toMatch(/tkt-000000000009/);
  });

  // Control for the case above: the SAME board minus the corrupt file exits 0, so the 2 is
  // attributable to the unreadable file and not to the in-progress ticket beside it.
  it('exits 0 on that same board once the unreadable file is removed', () => {
    const root = board({ 'tkt-000000000001.md': ticket({ body: 'Status stays `in-progress`.' }) });
    expect(run([CLI, root]).status).toBe(0);
  });

  // A crash used to exit 1 — the status SKILL.md defines as the expected advisory result, so a
  // half-printed crashed run was indistinguishable from a normal one.
  it('exits 2, not 1, when a ticket crashes the run mid-scan', () => {
    // An empty-valued frontmatter key parses to [], which has no padEnd/localeCompare.
    const root = board({
      'tkt-000000000001.md': '---\nid: tkt-000000000001\ntitle: t\nstatus: in-progress\nproject:\n---\nStatus stays `in-progress`.\n',
    });
    const { status, out } = run([CLI, root]);
    // Accounted, so 0 is the correct code. What is being pinned is that it did not CRASH: before the
    // display seam normalized the value this threw at `[].padEnd` and exited 1 — an advisory status.
    expect(status).toBe(0);
    expect(out).toMatch(/\(no project\)/);
    expect(out).not.toMatch(/crashed mid-scan/);
  });

  // F10: fence-stripping is right for deciding whether a marker COUNTS and wrong for display.
  // Checkpoints routinely put the branch, the failing command or the next step inside a fence.
  it('shows fenced content in the body tail a human is told to read', () => {
    const root = board({
      'tkt-000000000001.md': ticket({ body: 'No reason stated.\n\n```\ngit switch task/tkt-000000000001-next-step\n```' }),
    });
    const { status, out } = run([CLI, root]);
    expect(status).toBe(1);
    expect(out).toMatch(/git switch task\/tkt-000000000001-next-step/);
  });

  // tkt-b86d2a318f8b's shape, which shipped here too: with a raw `file://` string comparison the CLI
  // ran nothing and exited 0 through a symlink — a clean-board reading from a probe that never
  // scanned. Reproduced against this file before the fix; this is the control that keeps it fixed.
  it('runs when invoked through a symlink, instead of exiting 0 in silence', () => {
    const link = path.join(tmp, 'linked-probe.mjs');
    fs.symlinkSync(CLI, link);
    const root = board({ 'tkt-000000000001.md': ticket({ body: 'No reason stated.' }) });
    const { status, out } = run([link, root]);
    expect(status).toBe(1);
    expect(out).toMatch(/scanned 1 tickets/);
  });

  // Positive control on the assertion above: the symlink case would pass vacuously if the probe
  // exited non-zero for any reason at all, so pin that a DIRECT run of the same board agrees.
  it('reports the same result through a symlink as it does directly', () => {
    const link = path.join(tmp, 'linked-probe.mjs');
    fs.symlinkSync(CLI, link);
    const root = board({ 'tkt-000000000001.md': ticket({ body: 'No reason stated.' }) });
    const direct = run([CLI, root]);
    const linked = run([link, root]);
    expect(linked.status).toBe(direct.status);
    expect(linked.out).toBe(direct.out);
  });
});

// tkt-3d25ae0626c6. process.exit() drops pending stdout writes on a pipe, cutting a long report at
// the 64KB buffer with no error. Measured on a 400-ticket board: 1,527,895 bytes direct, 65,446
// through a STALLED reader, 3 runs of 3. A fast reader (`| cat | wc -c`) drains the buffer and hides
// it completely, which is why an earlier check of this reported no defect. nul-bytes.mjs carries the
// same rule and merged-branches.test.mjs pins it the same way.
describe('does not truncate a long report through a pipe', () => {
  const bigBoard = () => {
    const files = {};
    for (let i = 0; i < 120; i += 1) {
      const id = `tkt-${String(i).padStart(12, '0')}`;
      const body = Array.from({ length: 30 }, (_, j) => `line ${j} ${'x'.repeat(160)}`).join('\n');
      files[`${id}.md`] = ticket({ id, body });
    }
    return board(files);
  };

  it('delivers the whole report to a reader that stalls before reading', () => {
    const root = bigBoard();
    const direct = run([CLI, root]).out;
    expect(direct.length, 'board must exceed the 64KB pipe buffer or this asserts nothing')
      .toBeGreaterThan(65_536 * 2);
    const piped = execFileSync('sh', ['-c',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${JSON.stringify(root)} 2>/dev/null | { sleep 1; cat; }`,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(piped.length).toBe(direct.length);
    // The last line is the summary; a truncating exit cut the report mid-line before reaching it.
    expect(piped.trimEnd().endsWith(direct.trimEnd().split('\n').pop())).toBe(true);
  });

  // Source-level assertion, the same shape merged-branches.test.mjs uses. The integration test above
  // only covers the paths it happens to exercise; this covers every exit site in the file.
  it('uses process.exitCode throughout, never process.exit()', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    expect(src).toMatch(/process\.exitCode/); // control: the replacement IS present
    expect(src).not.toMatch(/process\.exit\(/);
  });
});

// F3: a ticket excused by a phrase is the direction where a false positive is dangerous, and it was
// the direction the output gave a human nothing to check.
describe('an accounted ticket names the phrase that excused it', () => {
  it('prints the matched line, not a bare "DECLARED in body"', () => {
    const root = board({
      'tkt-000000000001.md': ticket({ body: 'Preamble.\nStatus stays `in-progress` until the vendor replies.\nMore.' }),
    });
    const { status, out } = run([CLI, root]);
    expect(status).toBe(0);
    expect(out).toMatch(/DECLARED L2: "Status stays `in-progress` until the vendor replies\."/);
  });

  it('reports the line number and a bounded excerpt', () => {
    const m = intentMatch('a\nb\nPAUSED pending an EIN.\nc');
    expect(m.line).toBe(3);
    expect(m.phrase).toBe('PAUSED');
    expect(m.excerpt).toBe('PAUSED pending an EIN.');
  });

  it('truncates a very long matched line rather than flooding the report', () => {
    const m = intentMatch(`PAUSED ${'y'.repeat(400)}`);
    expect(m.excerpt.length).toBeLessThanOrEqual(90);
    expect(m.excerpt.endsWith('...')).toBe(true);
  });

  it('returns null when nothing matches, so hasIntent cannot be true vacuously', () => {
    expect(intentMatch('ordinary prose about a parser')).toBeNull();
  });
});

// The controls are the reason a count from this probe is worth anything. If assertInstruments stops
// firing, every test above still passes — they exercise the classifier it guards, not the guard.
describe('assertInstruments blocks a broken classifier', () => {
  // Run a MUTATED copy of the source: the only way to observe that the built-in controls actually
  // abort, since they run inside main() and close over a module-scoped classify().
  function runMutated(replace) {
    const src = fs.readFileSync(CLI, 'utf8');
    const mutated = replace(src);
    expect(mutated, 'mutation did not apply — the control below would pass vacuously').not.toBe(src);
    const copy = path.join(tmp, 'mutated.mjs');
    fs.writeFileSync(copy, mutated);
    return run([copy, board({ 'tkt-000000000001.md': ticket({ body: 'No reason stated.' }) })]);
  }

  it('refuses to report a clean board when classify() is forced to always account', () => {
    const { status, out } = runMutated((s) =>
      s.replace("tier: reasons.length ? 'accounted' : 'unaccounted',", "tier: 'accounted',"));
    expect(status).not.toBe(0);
    expect(out).toMatch(/instrument: control "stale \+ silent => the finding"/);
  });

  it('refuses to run when the fenced-code stripper is disabled', () => {
    const { status, out } = runMutated((s) =>
      s.replace('function stripFences(body) {\n  return body.replace', 'function stripFences(body) {\n  return body; // eslint-disable-line no-unreachable\n  return body.replace'));
    expect(status).not.toBe(0);
    expect(out).toMatch(/instrument: control "fenced marker does not count"/);
  });
});

describe('classify', () => {
  const t = (opts) => parseTicket(ticket(opts));

  it('is unaccounted when a stale ticket states no reason', () => {
    expect(classify(t({}), () => 'done', NOW).tier).toBe('unaccounted');
  });

  it('a CLOSED blocker does not excuse the ticket', () => {
    const got = classify(t({ blockers: ['tkt-000000000002'] }), () => 'done', NOW);
    expect(got.tier).toBe('unaccounted');
    expect(got.reasons).toHaveLength(0);
  });

  it('an OPEN blocker accounts for it, and names the blocker\'s status', () => {
    const got = classify(t({ blockers: ['tkt-000000000002'] }), () => 'todo', NOW);
    expect(got.tier).toBe('accounted');
    expect(got.reasons.join(' ')).toMatch(/BLOCKED by tkt-000000000002\(todo\)/);
  });

  it('a blocker that does not exist is reported as rot, never as blocked', () => {
    const got = classify(t({ blockers: ['tkt-ffffffffffff'] }), () => undefined, NOW);
    expect(got.rottenBlockers).toEqual(['tkt-ffffffffffff']);
    expect(got.tier).toBe('unaccounted');
  });

  it('an unparseable updated date yields a null age rather than a false TOUCHED', () => {
    const got = classify({ blockers: [], body: 'x', updated: 'not-a-date' }, () => 'done', NOW);
    expect(got.ageDays).toBeNull();
    expect(got.reasons.join(' ')).not.toMatch(/TOUCHED/);
  });
});

describe('hasIntent', () => {
  it.each([
    'Status stays `in-progress` until the vendor replies.',
    'This remains in-progress deliberately.',
    'PAUSED pending an EIN.',
    'Resume here after the spike.',
  ])('reads a declared hold: %s', (body) => {
    expect(hasIntent(body)).toBe(true);
  });

  // Negative control. Without this the matcher could be a function returning true, and every
  // positive case above would still pass.
  it.each([
    'Implemented the parser and opened a PR.',
    'Work in progress on the retrieval layer.',
    'The status field was updated.',
    // tkt-3d25ae0626c6, the finding that made this fix necessary: /blocked on/ matched 73 of 1264
    // live ticket files. Every shape below is real prose from this board, and every one of them
    // would have silenced a genuinely orphaned ticket. The structured `blockers` field carries this
    // signal precisely; prose cannot. Do not restore the phrase.
    '## Blocked on the Articles, genuinely',
    'That twin is blocked on tkt-1f7a72b5d7c0.',
    '`tkt-c8d4a7defa35` stays blocked on this ticket.',
    'This keeps the ticket from being blocked on a publishing decision.',
  ])('does not read ordinary prose as a declared hold: %s', (body) => {
    expect(hasIntent(body)).toBe(false);
  });

  // 252 of 1264 live bodies (20%) nest a fence inside a list, so a column-0-only stripper left the
  // guarantee unmet for the ordinary shape (tkt-3d25ae0626c6).
  it('does not count a marker quoted inside an INDENTED fenced block', () => {
    expect(hasIntent('- example:\n  ```\n  Status stays `in-progress`\n  ```')).toBe(false);
    // Control: unfenced but equally indented text DOES count, so the case above tests the fence and
    // not the leading whitespace.
    expect(hasIntent('- example:\n  Status stays `in-progress`')).toBe(true);
  });

  it('does not count a marker quoted inside a fenced block', () => {
    expect(hasIntent('```\nStatus stays `in-progress`\n```')).toBe(false);
    // Control: the same text unfenced DOES count, so the case above is testing the fence and not a
    // phrase the list happens to miss.
    expect(hasIntent('Status stays `in-progress`')).toBe(true);
  });
});

describe('parseTicket', () => {
  it('returns null for a file with no frontmatter, so the caller can call it unreadable', () => {
    expect(parseTicket('just a body\n')).toBeNull();
  });

  it('reads a block-list blockers field', () => {
    const t = parseTicket(ticket({ blockers: ['tkt-000000000002', 'tkt-000000000003'] }));
    expect(t.blockers).toEqual(['tkt-000000000002', 'tkt-000000000003']);
  });

  it('reads an empty inline blockers list as empty, not as a key named "[]"', () => {
    expect(parseTicket('---\nstatus: todo\nblockers: []\n---\nbody\n').blockers).toEqual([]);
  });
});
