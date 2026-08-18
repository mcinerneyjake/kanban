import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

// Adoption counts for the workflow markers (tkt-6d0d8a0fe2d2). Two promotion gates read these
// numbers — red-first (tkt-a98723f627df) and the mutation check (tkt-06b572e5f00e) — and both were
// nearly fed by hand-rolled counters with two contamination paths: `tickets/.history/**` snapshots
// double-count any ticket edited after its summary landed, and an unfenced marker template quoted in
// a ticket body counts its own paperwork (the exact defect tkt-a98723f627df's CORRECTION fixed once).
// See `## Probe discipline` in CLAUDE.md.

export const MARKERS = {
  redFirst: /^Tests:.*written first, observed red/m,
  // `flipped,` is load-bearing: without it, a red-first bug ticket whose TEST NAME contains
  // "mutation: " (e.g. a mutation-harness repro) would count as both markers — inflation, the
  // dangerous direction for a promotion gate.
  mutationCheck: /^Tests:.*mutation: \S+.* flipped, observed red/m,
  // The sanctioned escape hatch is adoption too — an escape-hatch user must never read as a
  // non-adopter, so it gets its own counter rather than silently matching nothing.
  noneCatchable: /^Tests:.*mutation: none catchable/m,
};

// Blank out fenced blocks INCLUDING the fence lines, preserving line structure so `^Tests:` can
// never match quoted-template content. CommonMark-shaped closing: only a run of the SAME character,
// at least as long as the opener, closes the fence — a `~~~` inside a backtick fence is content, not
// a closer, and treating it as one re-exposed the very template lines this exists to hide. An
// unclosed fence blanks to EOF — a malformed body must fail toward "not counted", never toward
// contaminating a promotion trigger.
export function stripFences(text) {
  let open = null; // { char, len } of the current fence, or null
  return text
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (open === null) {
        if (marker) {
          open = { char: marker[1][0], len: marker[1].length };
          return '';
        }
        return line;
      }
      const close = line.match(new RegExp(`^\\s*(\\${open.char}{${open.len},})\\s*$`));
      if (close) open = null;
      return '';
    })
    .join('\n');
}

export function classifyDoc(raw) {
  // gray-matter, not a regex over the raw text: a match-anywhere `project:` regex let a fenced
  // frontmatter EXAMPLE in a body set the scoping field, and read js-yaml-quoted values literally.
  // Markers are likewise scanned over the BODY only.
  let project = null;
  let body = raw;
  try {
    const parsed = matter(raw);
    body = parsed.content;
    if (typeof parsed.data.project === 'string' && parsed.data.project.trim() !== '') {
      project = parsed.data.project.trim();
    }
  } catch {
    // Unparseable frontmatter: keep project null. The caller reports these as `unattributed`
    // rather than silently folding them into "not my project" — undercounting is the safe
    // direction for a promotion gate, but it must be visible, not silent.
  }
  const stripped = stripFences(body);
  return {
    project,
    redFirst: MARKERS.redFirst.test(stripped),
    mutationCheck: MARKERS.mutationCheck.test(stripped),
    noneCatchable: MARKERS.noneCatchable.test(stripped),
  };
}

// Dot-directories are skipped by name, which is what excludes `.history/` — its files are snapshots
// of ticket bodies, so every marker in them is a duplicate of (or a ghost of) a live ticket's.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.md') ? [full] : [];
  });
}

const NONE = { redFirst: false, mutationCheck: false, noneCatchable: false };
const CONTROLS = [
  // positive: the three compliant recording forms, exactly where the rules say they live
  { doc: '---\nproject: kanban\n---\nTests: 1 added — repro (written first, observed red)\n', expect: { ...NONE, redFirst: true } },
  { doc: '---\nproject: kanban\n---\nTests: 2 added — cov; mutation: src/a.ts:12 flipped, observed red\n', expect: { ...NONE, mutationCheck: true } },
  { doc: '---\nproject: kanban\n---\nTests: 2 added — cov; mutation: none catchable — only e2e covers it\n', expect: { ...NONE, noneCatchable: true } },
  // positive: a js-yaml-quoted project value still scopes
  { doc: "---\nproject: 'kanban'\n---\nTests: 1 added — q (written first, observed red)\n", expect: { ...NONE, redFirst: true } },
  // negative: a red-first line whose TEST NAME contains "mutation: " counts once, not twice
  { doc: '---\nproject: kanban\n---\nTests: 1 added — mutation: harness repro (written first, observed red)\n', expect: { ...NONE, redFirst: true } },
  // negative: a fenced template must not count — paperwork is not adoption
  { doc: '---\nproject: kanban\n---\nUse this form:\n```\nTests: N added — x (written first, observed red)\nTests: N added — x; mutation: f:1 flipped, observed red\n```\n', expect: NONE },
  // negative: a ~~~ INSIDE a backtick fence is content, not a closer
  { doc: '---\nproject: kanban\n---\n```\n~~~\nTests: 1 added — x (written first, observed red)\n```\n', expect: NONE },
  // negative: a prose mention off the Tests: line
  { doc: '---\nproject: kanban\n---\nThe marker written first, observed red is load-bearing; mutation: anything flipped, observed red too.\n', expect: NONE },
  // negative: the audit-fix phrase deliberately shares no literal with any marker
  { doc: '---\nproject: kanban\n---\nTests: 3 fixed — pinned lengths; emptying-mutation control went red, reverted\n', expect: NONE },
  // negative: a wrapped continuation line does not carry the Tests: anchor
  { doc: '---\nproject: kanban\n---\nTests: 1 added — long description that wraps\n(written first, observed red); mutation: f:1 flipped, observed red\n', expect: NONE },
  // negative: an unclosed fence swallows the rest of the body
  { doc: '---\nproject: kanban\n---\n```\nTests: 1 added — x (written first, observed red)\n', expect: NONE },
];

// The loud control: a probe whose classifier is wrong must throw, never emit a plausible count.
// `classify` is injectable so the test can watch the throw path itself go red.
export function assertInstruments(classify = classifyDoc) {
  for (const [i, c] of CONTROLS.entries()) {
    const got = classify(c.doc);
    for (const key of Object.keys(NONE)) {
      if (got[key] !== c.expect[key]) {
        throw new Error(
          `adoption-markers: control ${i} misclassified (${key}: got ${got[key]}, expected ${c.expect[key]}) — refusing to count.`,
        );
      }
    }
    if (got.project !== 'kanban') {
      throw new Error(`adoption-markers: control ${i} lost its project field — refusing to count.`);
    }
  }
}

export function scanBoard(boardRoot, { project = 'kanban' } = {}) {
  assertInstruments();
  const dir = path.join(boardRoot, 'tickets');
  if (!fs.existsSync(dir)) {
    throw new Error(`adoption-markers: no tickets/ directory under ${boardRoot} — cannot scan, refusing to report 0.`);
  }
  const files = walk(dir);
  if (files.length === 0) {
    throw new Error(`adoption-markers: scanned 0 ticket files under ${dir} — an empty scan is not a zero count.`);
  }

  const result = {
    project,
    scanned: files.length,
    matchedProject: 0,
    unattributed: 0,
    redFirst: { count: 0, ids: [] },
    mutationCheck: { count: 0, ids: [] },
    noneCatchable: { count: 0, ids: [] },
  };
  for (const file of files) {
    const got = classifyDoc(fs.readFileSync(file, 'utf8'));
    if (got.project === null) result.unattributed += 1;
    if (got.project !== project) continue;
    result.matchedProject += 1;
    const id = path.basename(file, '.md');
    for (const key of ['redFirst', 'mutationCheck', 'noneCatchable']) {
      if (got[key]) {
        result[key].count += 1;
        result[key].ids.push(id);
      }
    }
  }
  // A scope that selects nothing is an empty scan one level down — a typo'd --project must never
  // read as "zero adoption" (matchedProject > 0 with zero markers is what legitimate zero looks like).
  if (result.matchedProject === 0) {
    throw new Error(
      `adoption-markers: project "${project}" matched 0 of ${result.scanned} scanned tickets — a scope that selects nothing is not a zero count.`,
    );
  }
  for (const key of ['redFirst', 'mutationCheck', 'noneCatchable']) result[key].ids.sort();
  return result;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const projectFlag = args.find((a) => a.startsWith('--project='));
  const boardRoot = args.find((a) => !a.startsWith('--')) ?? process.cwd();
  try {
    const report = scanBoard(boardRoot, projectFlag ? { project: projectFlag.slice('--project='.length) } : {});
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
