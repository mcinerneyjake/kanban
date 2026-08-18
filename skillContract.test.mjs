import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tkt-abaff4ebd8b3. The /kanban-workflow skill's gate table is a claim about a file tracked in THIS
// repo, so per CLAUDE.md ("Writing these documents", rule 2) it belongs in a test rather than in
// prose — CLAUDE.md previously asserted the table's shape by hand and the sentence went stale.
//
// WHAT IS ASSERTED: the gate table's structure — that its columns are exactly the expected gates in
// the expected order, that its rows are exactly the `--gates` levels §0 parses, and that every cell
// holds a value from that gate's allowlist. That is the structural half of the review gate: a level
// that crosses `commit` cannot have skipped `review`, because `review` has no skip value to hold.
//
// WHAT IS NOT ASSERTED, and must not be read as covered: that a run of the skill OBEYS the table.
// Nothing here observes a session, and in foreign mode this suite never runs at all. The prose in §9
// (the target repo's mutation / red-first checks) and §10 (calibration) is likewise unenforced — a
// word-grep for those would be the assertion-word probe CLAUDE.md measured at ~2% precision, so it is
// deliberately absent rather than approximated.

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = path.join(here, '.claude', 'skills', 'kanban-workflow', 'SKILL.md');

// An ALLOWLIST per gate, not a denylist of skip words. The first cut checked only "no cell says
// skip", and measured false-cleans on both halves of the table's real invariant: dropping the
// `merge` column entirely passed, and so did `auto-pr | … | cross` for merge — i.e. "merge is human
// in every mode" was the most consequential claim in the file and the one nothing asserted.
// Adding a gate or a value here must be a deliberate edit, which is the point.
const GATE_VALUES = {
  review: ['ask', 'run'],
  commit: ['ask', 'cross'],
  'pr open': ['ask', 'cross'],
  // Human in every mode. There is deliberately no `cross` here.
  merge: ['ask'],
};
// Order is load-bearing, not cosmetic: the review resolves BEFORE the commit, and that ordering has
// been "corrected" backwards once already (see CLAUDE.md's note on it).
const COLUMNS = ['level', ...Object.keys(GATE_VALUES)];

// Second layer, and NOT redundant with the allowlist: a qualified crossing like `ask — but skip when
// docs-only` normalizes to `ask` and would clear the allowlist. Unanchored on purpose — the first
// cut anchored `^…$` and let `n/a (docs-only)`, `skip if docs-only` and `optional — see §14` through.
const SKIP_WORD = /\b(?:skip(?:s|ped)?|none|n\/?a|optional|waive[ds]?|never)\b/i;

function stripMarkup(cell) {
  return cell.replace(/[*`]/g, '').trim();
}

// `| \`manual\` (default) |` names the level `manual`; the parenthetical is prose.
function levelLabel(cell) {
  return stripMarkup(cell).replace(/\s*\(.*\)\s*/, '').trim();
}

// `**ask — always**` is the value `ask` with an emphasis qualifier. The dash form requires a
// FOLLOWING space so a hyphenated token is never split.
function gateValue(cell) {
  return stripMarkup(cell)
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s*[—–-]\s.*$/, '')
    .trim()
    .toLowerCase();
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function parseSkill(md) {
  const lines = md.split('\n');
  const flag = md.match(/`--gates ([^`]+)`/);
  const levels = flag ? flag[1].split('|').map((s) => s.trim()) : null;

  const gateHeadings = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^##\s/.test(line) && /\bgates\b/i.test(line));
  // Binding to the FIRST match would let a later-added section titled "…gates…" retarget the parser
  // at some other table, silently. Ambiguity is reported, never resolved by position.
  if (gateHeadings.length !== 1) return { levels, table: null, gateHeadings: gateHeadings.length };

  const rest = lines.slice(gateHeadings[0].i + 1);
  const endRel = rest.findIndex((l) => /^##\s/.test(l));
  const section = endRel === -1 ? rest : rest.slice(0, endRel);

  const rows = section.filter((l) => l.trimStart().startsWith('|'));
  // header + separator + at least one level
  if (rows.length < 3) return { levels, table: null, gateHeadings: 1 };
  return {
    levels,
    gateHeadings: 1,
    table: {
      columns: splitRow(rows[0]).map((c) => stripMarkup(c).toLowerCase()),
      // rows[1] is the `|---|` separator.
      body: rows.slice(2).map(splitRow),
    },
  };
}

export function gateTableProblems(md) {
  const problems = [];
  const { levels, table, gateHeadings } = parseSkill(md);

  if (!levels) problems.push('no `--gates <levels>` flag found in §0 — cannot derive the level set');
  if (!table) {
    problems.push(
      gateHeadings > 1
        ? `${gateHeadings} headings match "gates" — cannot tell which table is the gate table`
        : 'no gate table found under a "gates" heading',
    );
    return problems;
  }

  const { columns, body } = table;
  if (columns.join(' | ') !== COLUMNS.join(' | ')) {
    problems.push(`gate columns are [${columns.join(', ')}], expected [${COLUMNS.join(', ')}]`);
  }

  const labelled = body.map((cells) => levelLabel(cells[0]));
  if (levels) {
    const missing = levels.filter((l) => !labelled.includes(l));
    const extra = labelled.filter((l) => !levels.includes(l));
    if (missing.length) problems.push(`gate levels with no table row: ${missing.join(', ')}`);
    if (extra.length) problems.push(`table rows naming no parsed gate level: ${extra.join(', ')}`);
  }

  for (const cells of body) {
    const level = levelLabel(cells[0]);
    for (let i = 1; i < columns.length; i += 1) {
      const gate = columns[i];
      const allowed = GATE_VALUES[gate];
      if (!allowed) continue; // unknown column already reported above
      const raw = cells[i] ?? '';
      if (!allowed.includes(gateValue(raw))) {
        problems.push(`${level}'s ${gate} value is "${raw.trim() || '<empty>'}", expected one of ${allowed.join('/')}`);
      } else if (SKIP_WORD.test(raw)) {
        problems.push(`${level} may skip the ${gate} gate ("${raw.trim()}")`);
      }
    }
  }
  return problems;
}

const REAL = fs.readFileSync(SKILL_PATH, 'utf8');

describe('kanban-workflow skill: gate table', () => {
  it('parses a real table — non-vacuity, so "no problems" cannot mean "nothing scanned"', () => {
    const { levels, table } = parseSkill(REAL);
    expect(levels, 'the `--gates` flag line is what the row set is checked against').toEqual(
      ['manual', 'auto-commit', 'auto-pr'],
    );
    expect(table, 'no table parsed — every assertion below would pass vacuously').not.toBeNull();
    expect(table.columns).toEqual(COLUMNS);
    expect(table.body.length).toBe(levels.length);
  });

  it('carries a review gate no level can skip', () => {
    expect(gateTableProblems(REAL)).toEqual([]);
  });

  it('keeps merge human at every level', () => {
    const { table } = parseSkill(REAL);
    const merge = table.columns.indexOf('merge');
    expect(table.body.map((cells) => gateValue(cells[merge]))).toEqual(
      table.body.map(() => 'ask'),
    );
  });
});

// Controls. Without these, a parser that quietly matched nothing would report the file clean —
// the failure shape this repo's probe discipline exists to catch.
describe('kanban-workflow skill: the checker itself', () => {
  const FLAG = '- `--gates manual|auto-commit|auto-pr` → default **`manual`**.\n\n';
  const table = (header, ...rows) =>
    ['## 11–13. The gates', '', header, '|---|---|---|---|---|', ...rows, '', '## 14. Next'].join('\n');
  const HEADER = '| level | review | commit | PR open | merge |';
  const GOOD = [
    '| `manual` (default) | ask | ask | ask | ask |',
    '| `auto-commit` | run | cross | ask | ask |',
    '| `auto-pr` | run | cross | cross | **ask — always** |',
  ];

  it('passes a correct table — so the flags below are not fired by everything', () => {
    expect(gateTableProblems(FLAG + table(HEADER, ...GOOD))).toEqual([]);
  });

  it('flags a table with no review column', () => {
    const md = FLAG + table(
      '| level | commit | PR open | merge |',
      '| `manual` (default) | ask | ask | ask |',
      '| `auto-commit` | cross | ask | ask |',
      '| `auto-pr` | cross | cross | **ask — always** |',
    );
    expect(gateTableProblems(md)).toContain(
      'gate columns are [level, commit, pr open, merge], expected [level, review, commit, pr open, merge]',
    );
  });

  it('flags a DROPPED merge column, not just a bad merge value', () => {
    const md = FLAG + table(
      '| level | review | commit | PR open |',
      '| `manual` (default) | ask | ask | ask |',
      '| `auto-commit` | run | cross | ask |',
      '| `auto-pr` | run | cross | cross |',
    );
    expect(gateTableProblems(md)).toContain(
      'gate columns are [level, review, commit, pr open], expected [level, review, commit, pr open, merge]',
    );
  });

  it('flags an auto level that crosses the merge gate', () => {
    const md = FLAG + table(HEADER, GOOD[0], GOOD[1], '| `auto-pr` | run | cross | cross | cross |');
    expect(gateTableProblems(md)).toContain('auto-pr\'s merge value is "cross", expected one of ask');
  });

  it('flags a review cell that skips', () => {
    const md = FLAG + table(HEADER, GOOD[0], GOOD[1], '| `auto-pr` | skip | cross | cross | ask |');
    expect(gateTableProblems(md)).toContain('auto-pr\'s review value is "skip", expected one of ask/run');
  });

  it('flags a QUALIFIED skip in a non-review column', () => {
    const md = FLAG + table(HEADER, GOOD[0], GOOD[1], '| `auto-pr` | run | cross | ask — skip if docs-only | ask |');
    expect(gateTableProblems(md)).toContain('auto-pr may skip the pr open gate ("ask — skip if docs-only")');
  });

  it('flags "n/a (…)" and "optional — …", which an anchored matcher let through', () => {
    const na = FLAG + table(HEADER, '| `manual` (default) | n/a (docs-only) | ask | ask | ask |', GOOD[1], GOOD[2]);
    expect(gateTableProblems(na)).toContain('manual\'s review value is "n/a (docs-only)", expected one of ask/run');
    const opt = FLAG + table(HEADER, '| `manual` (default) | optional — see §14 | ask | ask | ask |', GOOD[1], GOOD[2]);
    expect(gateTableProblems(opt)).toContain('manual\'s review value is "optional — see §14", expected one of ask/run');
  });

  it('flags an empty or dash-only cell', () => {
    const md = FLAG + table(HEADER, '| `manual` (default) | — | ask | ask | ask |', GOOD[1], GOOD[2]);
    expect(gateTableProblems(md)).toContain('manual\'s review value is "—", expected one of ask/run');
  });

  it('flags review ordered after commit', () => {
    const md = FLAG + table(
      '| level | commit | review | PR open | merge |',
      '| `manual` (default) | ask | ask | ask | ask |',
      '| `auto-commit` | cross | run | ask | ask |',
      '| `auto-pr` | cross | run | cross | **ask — always** |',
    );
    expect(gateTableProblems(md)).toContain(
      'gate columns are [level, commit, review, pr open, merge], expected [level, review, commit, pr open, merge]',
    );
  });

  it('flags a gate level the flag accepts but the table never lists', () => {
    const md = FLAG + table(HEADER, GOOD[0], GOOD[2]);
    expect(gateTableProblems(md)).toContain('gate levels with no table row: auto-commit');
  });

  it('reports a missing table rather than returning clean', () => {
    expect(gateTableProblems('# nothing here')).toContain('no gate table found under a "gates" heading');
  });

  it('refuses to guess when two headings match "gates"', () => {
    const md = FLAG + '## 3. Board gates\n\n| a | b |\n|---|---|\n| x | y |\n\n' + table(HEADER, ...GOOD);
    expect(gateTableProblems(md)).toContain('2 headings match "gates" — cannot tell which table is the gate table');
  });
});
