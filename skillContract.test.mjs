import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES } from './shared/constants.ts';

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
//
// tkt-34f8a4b467e7 adds the same treatment to §0's gate-level menu — the list `AskUserQuestion` is
// told to render when `--gates` is omitted. Asserted: every level the flag parses has a described
// entry, exactly one entry is recommended, and the recommended one is the level whose gate-table row
// asks at EVERY gate. Not asserted, for the same reason as above: that a run actually asks, or that
// an unanswered menu resolves to `manual`. Both are prose an agent obeys, not code that executes.

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

// The menu is bound to the section that DECLARES the flag, not to a heading name or a line number:
// a menu that drifts out of §0 away from the flag it documents is reported, never hunted for.
export function parseMenu(md) {
  const lines = md.split('\n');
  const flagIdx = lines.findIndex((l) => /`--gates [^`]+`/.test(l));
  if (flagIdx === -1) return null;
  let start = flagIdx;
  while (start > 0 && !/^##\s/.test(lines[start])) start -= 1;
  // A flag in an unheaded prologue has no heading line to step past; slicing past index 0 anyway
  // would drop a menu entry sitting on the first line.
  const rest = lines.slice(/^##\s/.test(lines[start]) ? start + 1 : start);
  const endRel = rest.findIndex((l) => /^##\s/.test(l));
  const section = endRel === -1 ? rest : rest.slice(0, endRel);

  const entries = [];
  for (const line of section) {
    // `- \`level\` (Recommended) — description`. The em dash is what separates an option from the
    // flag bullets above it, which use `→`; matching those would count the flag line as an entry.
    const m = line.match(/^-\s+`([^`]+)`\s*(\(Recommended\))?\s*—\s*(.*)$/);
    if (m) entries.push({ level: m[1].trim(), recommended: Boolean(m[2]), description: m[3].trim() });
  }
  return entries;
}

// "Safest" is DERIVED from the gate table, never named here: the level that asks at every gate. Hard-
// coding `manual` would let the table and the menu drift apart in exactly the way this binds shut.
function safestLevels(table) {
  return table.body
    // A row missing cells would pass `.every()` VACUOUSLY — `[].every()` is true — so a row that
    // specifies no gates at all would be classified as the one that asks at all of them.
    .filter((cells) => cells.length === table.columns.length)
    .filter((cells) => cells.slice(1).every((c) => gateValue(c) === 'ask'))
    .map((cells) => levelLabel(cells[0]));
}

export function gateMenuProblems(md) {
  const problems = [];
  const { levels, table } = parseSkill(md);
  const entries = parseMenu(md);

  if (!levels) problems.push('no `--gates <levels>` flag found in §0 — cannot derive the level set');
  if (entries === null || entries.length === 0) {
    problems.push('no gate-level menu found in the section that declares `--gates`');
    return problems;
  }

  const named = entries.map((e) => e.level);
  if (levels) {
    const missing = levels.filter((l) => !named.includes(l));
    const extra = named.filter((l) => !levels.includes(l));
    if (missing.length) problems.push(`gate levels with no menu entry: ${missing.join(', ')}`);
    if (extra.length) problems.push(`menu entries naming no parsed gate level: ${extra.join(', ')}`);
  }

  // `missing`/`extra` are set comparisons, so a level offered twice clears both while the menu
  // renders two options for it — and two entries for one level can carry contradicting descriptions.
  const repeated = [...new Set(named.filter((l, i) => named.indexOf(l) !== i))];
  if (repeated.length) problems.push(`gate levels offered more than once: ${repeated.join(', ')}`);

  for (const entry of entries) {
    if (!entry.description) problems.push(`${entry.level}'s menu entry has no description`);
  }

  const recommended = entries.filter((e) => e.recommended);
  if (recommended.length !== 1) {
    problems.push(
      `the menu marks ${recommended.length} entries (Recommended), expected exactly 1`
        + (recommended.length ? `: ${recommended.map((e) => e.level).join(', ')}` : ''),
    );
  } else if (!table) {
    // The recommendation is only ever checked AGAINST the gate table, so an unparseable table means
    // the most consequential half of this checker did not run. Returning clean here would report
    // "not checked" as "checked and fine" — the fail-open shape this repo rejects everywhere.
    problems.push('no gate table parsed, so the recommendation could not be checked against it');
  } else {
    const safest = safestLevels(table);
    // A table where no level asks everywhere, or where two do, cannot say which is safest — report
    // that rather than picking one, or the recommendation check passes on an arbitrary answer.
    if (safest.length !== 1) {
      problems.push(`${safest.length} gate levels ask at every gate, so "safest" is undecidable: [${safest.join(', ')}]`);
    } else if (recommended[0].level !== safest[0]) {
      // NOT "crosses a gate": `run` in the review column crosses nothing (that column has no skip
      // value), it pre-authorizes running the review. What disqualifies a level is asking less.
      problems.push(`the menu recommends \`${recommended[0].level}\`, which does not ask at every gate; \`${safest[0]}\` does`);
    }
  }

  // The first option is what a hurried reader takes, so its position is part of the default.
  if (recommended.length === 1 && named[0] !== recommended[0].level) {
    problems.push(`the recommended level \`${recommended[0].level}\` is not the first menu entry (\`${named[0]}\` is)`);
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

describe('kanban-workflow skill: gate-level menu (tkt-34f8a4b467e7)', () => {
  it('parses a real menu — non-vacuity, so "no problems" cannot mean "nothing scanned"', () => {
    const entries = parseMenu(REAL);
    expect(entries, 'no menu parsed — every assertion below would pass vacuously').not.toBeNull();
    expect(entries.map((e) => e.level)).toEqual(['manual', 'auto-commit', 'auto-pr']);
    expect(entries.every((e) => e.description.length > 0)).toBe(true);
  });

  it('offers every level, described, and recommends the one that asks at every gate', () => {
    expect(gateMenuProblems(REAL)).toEqual([]);
  });
});

describe('kanban-workflow skill: the menu checker itself', () => {
  const MENU = [
    '- `manual` (Recommended) — every gate asks.',
    '- `auto-commit` — commits without asking; PR-open and merge still ask.',
    '- `auto-pr` — commits and opens the PR without asking; merge still asks.',
  ];
  const doc = (...menu) => [
    '## 0. Parse `$ARGUMENTS`',
    '',
    '- `--gates manual|auto-commit|auto-pr` → default **`manual`**.',
    '',
    ...menu,
    '',
    '## 11–13. The gates',
    '',
    '| level | review | commit | PR open | merge |',
    '|---|---|---|---|---|',
    '| `manual` (default) | ask | ask | ask | ask |',
    '| `auto-commit` | run | cross | ask | ask |',
    '| `auto-pr` | run | cross | cross | **ask — always** |',
    '',
    '## 14. Next',
  ].join('\n');

  it('passes a correct menu — so the flags below are not fired by everything', () => {
    expect(gateMenuProblems(doc(...MENU))).toEqual([]);
  });

  it('flags a level the flag accepts but the menu never offers', () => {
    expect(gateMenuProblems(doc(MENU[0], MENU[2]))).toContain('gate levels with no menu entry: auto-commit');
  });

  it('flags an entry with no description', () => {
    expect(gateMenuProblems(doc('- `manual` (Recommended) — ', MENU[1], MENU[2])))
      .toContain("manual's menu entry has no description");
  });

  it('flags a menu with no recommendation at all', () => {
    expect(gateMenuProblems(doc('- `manual` — every gate asks.', MENU[1], MENU[2])))
      .toContain('the menu marks 0 entries (Recommended), expected exactly 1');
  });

  it('flags two recommendations, which is no recommendation', () => {
    expect(gateMenuProblems(doc(MENU[0], '- `auto-commit` (Recommended) — commits for you.', MENU[2])))
      .toContain('the menu marks 2 entries (Recommended), expected exactly 1: manual, auto-commit');
  });

  it('flags a recommendation on a level that crosses a gate', () => {
    const md = doc(
      '- `auto-pr` (Recommended) — commits and opens the PR without asking.',
      '- `manual` — every gate asks.',
      MENU[1],
    );
    expect(gateMenuProblems(md)).toContain(
      'the menu recommends `auto-pr`, which does not ask at every gate; `manual` does',
    );
  });

  it('flags a recommendation that is not the first option', () => {
    expect(gateMenuProblems(doc(MENU[1], MENU[0], MENU[2])))
      .toContain('the recommended level `manual` is not the first menu entry (`auto-commit` is)');
  });

  it('flags a menu entry naming no parsed level', () => {
    expect(gateMenuProblems(doc(...MENU, '- `auto-merge` — merges for you.')))
      .toContain('menu entries naming no parsed gate level: auto-merge');
  });

  it('reports a missing menu rather than returning clean', () => {
    expect(gateMenuProblems(doc())).toContain(
      'no gate-level menu found in the section that declares `--gates`',
    );
  });

  it('reports a menu that drifted out of the section declaring the flag', () => {
    const md = doc().replace('## 11–13. The gates', ['## 0.5. Elsewhere', '', ...MENU, '', '## 11–13. The gates'].join('\n'));
    expect(gateMenuProblems(md)).toContain(
      'no gate-level menu found in the section that declares `--gates`',
    );
  });

  it('reports an UNPARSEABLE gate table rather than clearing the recommendation', () => {
    // The review found this returning [] for a menu recommending auto-pr: not checked, read as fine.
    const bad = doc(
      '- `auto-pr` (Recommended) — commits and opens the PR without asking.',
      '- `manual` — every gate asks.',
      MENU[1],
    ).replace('## 11–13. The gates', '## 11–13. The approvals');
    expect(gateMenuProblems(bad)).toContain(
      'no gate table parsed, so the recommendation could not be checked against it',
    );
  });

  it('does not treat a row with no gate cells as the level that asks at every gate', () => {
    // `[].every()` is true, so a truncated row read as all-ask and validated the recommendation
    // against a row specifying nothing.
    const md = doc(...MENU).replace('| `manual` (default) | ask | ask | ask | ask |', '| `manual` (default) |');
    expect(gateMenuProblems(md)).toContain(
      '0 gate levels ask at every gate, so "safest" is undecidable: []',
    );
  });

  it('flags a level offered twice, which set comparison alone misses', () => {
    const md = doc(MENU[0], '- `manual` — actually crosses everything.', MENU[1], MENU[2]);
    expect(gateMenuProblems(md)).toContain('gate levels offered more than once: manual');
  });

  it('refuses to name a safest level when the table has none', () => {
    const md = doc(...MENU).replace('| `manual` (default) | ask | ask | ask | ask |', '| `manual` (default) | ask | cross | ask | ask |');
    expect(gateMenuProblems(md)).toContain(
      '0 gate levels ask at every gate, so "safest" is undecidable: []',
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

// ---------------------------------------------------------------------------
// tkt-6dbfbd65a71c. §15's close table, given the same treatment as the gate table above.
//
// WHAT IS ASSERTED: that the close table names EVERY ticket type the board defines — derived from
// `TYPES` in shared/constants.ts, so adding a type upstream reddens this rather than quietly leaving
// it unconsidered — and that no cell holds a value letting a type close without the wrap-up check.
// That is the whole content of the ticket's "regardless of type": the rows are identical on purpose.
//
// WHAT IS NOT ASSERTED: that a run performs the check, or prints the handoff. Nothing here observes a
// session, and in foreign mode this suite never runs at all — the same limit §15 states in prose.

// `ask` only. There is deliberately no value here that closes a ticket without asking, exactly as
// GATE_VALUES.merge has no `cross`: that absence IS the invariant, and a denylist of skip words would
// have let `defer`, `auto` or a dropped column through.
const CLOSE_VALUES = {
  'wrap-up check': ['ask'],
  handoff: ['print'],
};
const CLOSE_COLUMNS = ['ticket type', ...Object.keys(CLOSE_VALUES)];

export function parseCloseTable(md) {
  const lines = md.split('\n');
  // Bound to the heading that NAMES the wrap-up check, not to a section number: §15 has been
  // renumbered once already, and a number is the part of a heading most likely to move.
  const headings = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^##\s/.test(line) && /\bwrap-up\b/i.test(line));
  if (headings.length !== 1) return { table: null, headings: headings.length };

  const rest = lines.slice(headings[0].i + 1);
  const endRel = rest.findIndex((l) => /^##\s/.test(l));
  const section = endRel === -1 ? rest : rest.slice(0, endRel);

  const rows = section.filter((l) => l.trimStart().startsWith('|'));
  if (rows.length < 3) return { table: null, headings: 1 };
  return {
    table: {
      columns: splitRow(rows[0]).map((c) => stripMarkup(c).toLowerCase()),
      body: rows.slice(2).map(splitRow),
    },
    headings: 1,
  };
}

export function closeTableProblems(md, types) {
  const problems = [];
  const { table, headings } = parseCloseTable(md);
  if (!table) {
    problems.push(
      headings > 1
        ? `${headings} headings match "wrap-up" — cannot tell which table is the close table`
        : 'no close table found under a "wrap-up" heading',
    );
    return problems;
  }

  const { columns, body } = table;
  if (columns.join(' | ') !== CLOSE_COLUMNS.join(' | ')) {
    problems.push(`close columns are [${columns.join(', ')}], expected [${CLOSE_COLUMNS.join(', ')}]`);
  }

  const named = body.map((cells) => levelLabel(cells[0]));
  const missing = types.filter((t) => !named.includes(t));
  const extra = named.filter((t) => !types.includes(t));
  if (missing.length) problems.push(`ticket types with no close row: ${missing.join(', ')}`);
  if (extra.length) problems.push(`close rows naming no ticket type: ${extra.join(', ')}`);
  // Set comparison clears a type listed twice, and two rows for one type can contradict each other.
  const repeated = [...new Set(named.filter((t, i) => named.indexOf(t) !== i))];
  if (repeated.length) problems.push(`ticket types with more than one close row: ${repeated.join(', ')}`);

  for (const cells of body) {
    const type = levelLabel(cells[0]);
    for (let i = 1; i < columns.length; i += 1) {
      const column = columns[i];
      const allowed = CLOSE_VALUES[column];
      if (!allowed) continue; // unknown column already reported above
      const raw = cells[i] ?? '';
      if (!allowed.includes(gateValue(raw))) {
        problems.push(`${type}'s ${column} value is "${raw.trim() || '<empty>'}", expected one of ${allowed.join('/')}`);
      } else if (SKIP_WORD.test(raw)) {
        problems.push(`${type} may skip the ${column} ("${raw.trim()}")`);
      }
    }
  }
  return problems;
}

describe('kanban-workflow skill: close table (tkt-6dbfbd65a71c)', () => {
  it('parses a real table — non-vacuity, so "no problems" cannot mean "nothing scanned"', () => {
    const { table } = parseCloseTable(REAL);
    expect(table, 'no close table parsed — every assertion below would pass vacuously').not.toBeNull();
    expect(table.columns).toEqual(CLOSE_COLUMNS);
    expect(table.body.length).toBe(TYPES.length);
  });

  it('asks the wrap-up check for every ticket type, with no skip value', () => {
    expect(closeTableProblems(REAL, TYPES)).toEqual([]);
  });

  it('leaves no ticket type able to close unasked', () => {
    const { table } = parseCloseTable(REAL);
    const wrapUp = table.columns.indexOf('wrap-up check');
    expect(table.body.map((cells) => gateValue(cells[wrapUp]))).toEqual(table.body.map(() => 'ask'));
  });
});

describe('kanban-workflow skill: the close checker itself', () => {
  const CLOSE = [
    '| ticket type | wrap-up check | handoff |',
    '|---|---|---|',
    ...TYPES.map((t) => `| \`${t}\` | ask | print |`),
  ];
  const doc = (...rows) => ['## 15. Close — wrap-up check, then the handoff', '', ...rows, '', '## 16. Next'].join('\n');

  it('passes a correct table — so the flags below are not fired by everything', () => {
    expect(closeTableProblems(doc(...CLOSE), TYPES)).toEqual([]);
  });

  it('flags a ticket type the board defines but the table never lists', () => {
    expect(closeTableProblems(doc(...CLOSE.filter((r) => !r.includes('`chore`'))), TYPES))
      .toContain('ticket types with no close row: chore');
  });

  it('flags a type allowed to skip the wrap-up check', () => {
    const md = doc(...CLOSE.map((r) => (r.includes('`chore`') ? '| `chore` | skip | print |' : r)));
    expect(closeTableProblems(md, TYPES)).toContain('chore\'s wrap-up check value is "skip", expected one of ask');
  });

  it('flags a QUALIFIED skip, which a bare allowlist normalizes away', () => {
    const md = doc(...CLOSE.map((r) => (r.includes('`chore`') ? '| `chore` | ask — skip when docs-only | print |' : r)));
    expect(closeTableProblems(md, TYPES)).toContain('chore may skip the wrap-up check ("ask — skip when docs-only")');
  });

  it('flags a DROPPED wrap-up column, not just a bad cell value', () => {
    const md = doc(
      '| ticket type | handoff |',
      '|---|---|',
      ...TYPES.map((t) => `| \`${t}\` | print |`),
    );
    expect(closeTableProblems(md, TYPES))
      .toContain('close columns are [ticket type, handoff], expected [ticket type, wrap-up check, handoff]');
  });

  it('flags an empty or dash-only cell', () => {
    const md = doc(...CLOSE.map((r) => (r.includes('`bug`') ? '| `bug` | — | print |' : r)));
    expect(closeTableProblems(md, TYPES)).toContain('bug\'s wrap-up check value is "—", expected one of ask');
  });

  it('flags a type listed twice, which set comparison alone misses', () => {
    expect(closeTableProblems(doc(...CLOSE, '| `chore` | ask | print |'), TYPES))
      .toContain('ticket types with more than one close row: chore');
  });

  it('flags a row naming no ticket type', () => {
    expect(closeTableProblems(doc(...CLOSE, '| `epic` | ask | print |'), TYPES))
      .toContain('close rows naming no ticket type: epic');
  });

  it('reports a missing table rather than returning clean', () => {
    expect(closeTableProblems('# nothing here', TYPES))
      .toContain('no close table found under a "wrap-up" heading');
  });

  it('refuses to guess when two headings match "wrap-up"', () => {
    const md = '## 3. Wrap-up notes\n\n| a | b |\n|---|---|\n| x | y |\n\n' + doc(...CLOSE);
    expect(closeTableProblems(md, TYPES))
      .toContain('2 headings match "wrap-up" — cannot tell which table is the close table');
  });
});

// ---------------------------------------------------------------------------
// tkt-9fbe6c952590. The startup recommendation in kanban's CLAUDE.md and the close handoff in
// SKILL.md §15 are the SAME invocation printed at the two ends of a session, living in two files
// that nothing otherwise ties together. A hand-written "keep these in sync" note is not a mechanism
// (CLAUDE.md, "Generate, don't transcribe"), so the agreement is asserted here instead.
//
// WHAT IS ASSERTED: both files carry exactly one slash-command invocation in the bound section, they
// name the same skill, they pass the same `--gates` level, and that level is the one the gate table
// says asks at EVERY gate. The last is derived from the table via safestLevels(), never hardcoded to
// `manual` — hardcoding it is precisely what would let the table and the two prompts drift apart in
// three directions at once.
//
// WHAT IS NOT ASSERTED: that a session actually prints either line, that a run infers its level from
// anything, or that `<project>` is substituted before printing. The substitution obligation is prose
// in both files and a word-grep for it would be the assertion-word probe CLAUDE.md measured at ~2%
// precision — deliberately absent rather than approximated, exactly as in the two contracts above.
//
// TWO KNOWN FALSE-RED SHAPES, both loud rather than fail-open: a heading-shaped line inside a fenced
// block is excluded from slicing (fenceMask), but an unfenced markdown table or list item beginning
// with `#` is not; and a line that looks like a slash command but is not one would be counted. Loud
// is the acceptable direction here — the direction this checker must never fail in is clean.
//
// The adversarial fixtures below cover BOTH sides. The first cut mutated only the CLAUDE.md side, and
// two fail-opens survived all 60 tests: dropping the handoff-problem push made the checker return
// CLEAN for a SKILL.md with no handoff section at all, and dropping the handoff from the safest-level
// loop went unnoticed. One omission across a whole dimension, exactly as the adversary-list tenet in
// `~/.claude/CLAUDE.md` predicts — not five missing cases.

const CLAUDE_PATH = path.join(here, 'CLAUDE.md');

// A fenced line is never a heading. Without this a ```bash block inside the section whose body opens
// with `# ` truncates the slice there, and a legitimate edit is reported as having no invocation.
function fenceMask(lines) {
  let inFence = false;
  return lines.map((l) => {
    if (/^\s*(?:```|~~~)/.test(l)) { inFence = !inFence; return true; }
    return inFence;
  });
}

// Slices by heading DEPTH. What the depth buys is precision, NOT protection from mis-binding: the
// ambiguity guard below already refuses to resolve two matches by position, so a depth-blind anchor
// would go red rather than bind wrongly. It would go red on the CORRECT file, though — `## 15. Close
// the ticket — wrap-up check, then the handoff` also matches /handoff/ — which is a checker that
// cannot be satisfied, not a checker that lies.
// A same-or-shallower heading closes the slice; deeper ones are part of it (the `### Recommending`
// subsection lives inside `## Session startup`, and must not be cut off from it).
function sliceSection(md, depth, nameRe) {
  const lines = md.split('\n');
  const fenced = fenceMask(lines);
  const opens = new RegExp(`^#{${depth}}\\s`);
  const closes = new RegExp(`^#{1,${depth}}\\s`);
  const heads = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => !fenced[i] && opens.test(line) && nameRe.test(line));
  // Ambiguity is reported, never resolved by position — the same rule the gate-table parser follows.
  if (heads.length !== 1) return { section: null, headings: heads.length };
  const start = heads[0].i + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (!fenced[i] && closes.test(lines[i])) { end = i; break; }
  }
  return { section: lines.slice(start, end), headings: 1 };
}

// A slash-command shape at the start of a line. Two things it deliberately excludes: inline mentions
// (`` `/kanban-workflow` `` in prose or in a heading), because matching those would let a file whose
// real invocation had been deleted still parse off a sentence that merely names the skill; and paths
// like `/api/tickets`, hence the single-segment name — a second `/` fails the lookahead rather than
// parsing as a command with no `--gates`.
function invocationsIn(section) {
  return section
    .map((l) => l.trim())
    .map((l) => l.match(/^\/([A-Za-z][A-Za-z0-9-]*)(?=\s|$)(.*)$/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], rest: m[2], gates: (m[2].match(/--gates\s+(\S+)/) || [])[1] ?? null }));
}

function invocationOf(md, depth, nameRe, where) {
  const { section, headings } = sliceSection(md, depth, nameRe);
  if (!section) {
    return {
      invocation: null,
      problem: headings > 1
        ? `${headings} headings match ${where} — cannot tell which section carries the invocation`
        : `no section found for ${where}`,
    };
  }
  const found = invocationsIn(section);
  if (found.length === 0) return { invocation: null, problem: `no slash-command invocation in ${where}` };
  // Two invocations in one section can disagree with each other, and a set comparison downstream
  // would clear that by matching whichever one happened to come first.
  if (found.length > 1) {
    return { invocation: null, problem: `${found.length} slash-command invocations in ${where} — expected 1` };
  }
  return { invocation: found[0], problem: null };
}

export function startupPromptProblems(claudeMd, skillMd) {
  const problems = [];
  const startup = invocationOf(claudeMd, 2, /session startup/i, "CLAUDE.md's \"Session startup\" section");
  const handoff = invocationOf(skillMd, 3, /\bhandoff\b/i, "SKILL.md's \"The handoff\" subsection");
  if (startup.problem) problems.push(startup.problem);
  if (handoff.problem) problems.push(handoff.problem);
  // Returning here rather than comparing nulls: two missing invocations are trivially "equal", and
  // reporting that as agreement is the fail-open this whole file exists to refuse.
  if (!startup.invocation || !handoff.invocation) return problems;

  if (startup.invocation.skill !== handoff.invocation.skill) {
    problems.push(`startup recommends \`/${startup.invocation.skill}\` but the handoff prints \`/${handoff.invocation.skill}\``);
  }
  for (const [name, side] of [['startup recommendation', startup], ['close handoff', handoff]]) {
    if (!side.invocation.gates) problems.push(`the ${name} passes no \`--gates\` level`);
  }
  if (!startup.invocation.gates || !handoff.invocation.gates) return problems;

  if (startup.invocation.gates !== handoff.invocation.gates) {
    problems.push(
      `startup recommends \`--gates ${startup.invocation.gates}\` but the handoff prints \`--gates ${handoff.invocation.gates}\``,
    );
  }

  const { table } = parseSkill(skillMd);
  if (!table) {
    // Same reasoning as the menu checker: an unparseable table means the most consequential half of
    // this check did not run, and "not checked" must never be reported as "checked and fine".
    problems.push('no gate table parsed, so the recommended level could not be checked against it');
    return problems;
  }
  const safest = safestLevels(table);
  if (safest.length !== 1) {
    problems.push(`${safest.length} gate levels ask at every gate, so "safest" is undecidable: [${safest.join(', ')}]`);
    return problems;
  }
  for (const [name, side] of [['startup recommendation', startup], ['close handoff', handoff]]) {
    if (side.invocation.gates !== safest[0]) {
      problems.push(
        `the ${name} pre-fills \`--gates ${side.invocation.gates}\`, which does not ask at every gate; \`${safest[0]}\` does`,
      );
    }
  }
  return problems;
}

const REAL_CLAUDE = fs.readFileSync(CLAUDE_PATH, 'utf8');

describe('kanban-workflow skill: startup recommendation (tkt-9fbe6c952590)', () => {
  it('parses a real invocation from BOTH files — so "no problems" cannot mean "nothing scanned"', () => {
    const startup = invocationOf(REAL_CLAUDE, 2, /session startup/i, 'startup');
    const handoff = invocationOf(REAL, 3, /\bhandoff\b/i, 'handoff');
    expect(startup.problem, 'no startup invocation parsed — every assertion below would pass vacuously').toBeNull();
    expect(handoff.problem, 'no handoff invocation parsed — every assertion below would pass vacuously').toBeNull();
    expect(startup.invocation.skill).toBe('kanban-workflow');
    expect(handoff.invocation.skill).toBe('kanban-workflow');
  });

  it('opens and closes a session with the same invocation, at a level that asks at every gate', () => {
    expect(startupPromptProblems(REAL_CLAUDE, REAL)).toEqual([]);
  });

  it('pre-fills a gate level that crosses nothing', () => {
    const { invocation } = invocationOf(REAL_CLAUDE, 2, /session startup/i, 'startup');
    const { table } = parseSkill(REAL);
    expect(safestLevels(table)).toEqual([invocation.gates]);
  });
});

describe('kanban-workflow skill: the startup checker itself', () => {
  const GATES = [
    '## 11–13. The gates',
    '',
    '| level | review | commit | PR open | merge |',
    '|---|---|---|---|---|',
    '| `manual` (default) | ask | ask | ask | ask |',
    '| `auto-commit` | run | cross | ask | ask |',
    '| `auto-pr` | run | cross | cross | **ask — always** |',
  ].join('\n');
  const skillWith = (...handoff) => [
    '## 15. Close the ticket — wrap-up check, then the handoff',
    '',
    '### The handoff',
    '',
    ...handoff,
    '',
    GATES,
  ].join('\n');
  const skill = (invocation = '/kanban-workflow <project> --gates manual') => skillWith('```', invocation, '```');
  const claude = (...body) => ['# Kanban Project', '', '## Session startup (MANDATORY)', '', ...body, '', '## MCP server'].join('\n');
  const START = ['```', '/kanban-workflow <project> --gates manual', '```'];

  it('passes a matching pair — so the flags below are not fired by everything', () => {
    expect(startupPromptProblems(claude(...START), skill())).toEqual([]);
  });

  it('flags a startup prompt pre-filling an auto level', () => {
    const md = claude('```', '/kanban-workflow <project> --gates auto-pr', '```');
    expect(startupPromptProblems(md, skill())).toContain(
      'startup recommends `--gates auto-pr` but the handoff prints `--gates manual`',
    );
  });

  it('flags BOTH ends drifting together, which comparing them to each other alone misses', () => {
    // The two agreeing is not sufficient: an auto level pre-filled in both files agrees perfectly
    // and re-grants an authorization nobody gave. This is why the level is checked against the table.
    const md = claude('```', '/kanban-workflow <project> --gates auto-pr', '```');
    expect(startupPromptProblems(md, skill('/kanban-workflow <project> --gates auto-pr'))).toContain(
      'the startup recommendation pre-fills `--gates auto-pr`, which does not ask at every gate; `manual` does',
    );
  });

  it('flags an invocation carrying no --gates at all', () => {
    const md = claude('```', '/kanban-workflow <project>', '```');
    expect(startupPromptProblems(md, skill())).toContain('the startup recommendation passes no `--gates` level');
  });

  it('flags a startup prompt naming a different skill', () => {
    const md = claude('```', '/kanban-start <project> --gates manual', '```');
    expect(startupPromptProblems(md, skill())).toContain(
      'startup recommends `/kanban-start` but the handoff prints `/kanban-workflow`',
    );
  });

  it('reports a DELETED startup invocation rather than returning clean', () => {
    const md = claude('Just load the board and ask which ticket to start.');
    expect(startupPromptProblems(md, skill())).toContain(
      'no slash-command invocation in CLAUDE.md\'s "Session startup" section',
    );
  });

  it('does not count an inline mention in prose as the invocation', () => {
    // A file whose real invocation was deleted must not still parse off a sentence naming the skill.
    const md = claude('Consider using the `/kanban-workflow` skill for this.');
    expect(startupPromptProblems(md, skill())).toContain(
      'no slash-command invocation in CLAUDE.md\'s "Session startup" section',
    );
  });

  it('reports a missing startup SECTION rather than returning clean', () => {
    const md = ['# Kanban Project', '', '## MCP server', '', ...START].join('\n');
    expect(startupPromptProblems(md, skill())).toContain(
      'no section found for CLAUDE.md\'s "Session startup" section',
    );
  });

  it('refuses to guess when two sections match', () => {
    const md = claude(...START).replace('## MCP server', '## Session startup, continued\n\n## MCP server');
    expect(startupPromptProblems(md, skill())).toContain(
      '2 headings match CLAUDE.md\'s "Session startup" section — cannot tell which section carries the invocation',
    );
  });

  it('refuses to guess between two invocations in one section', () => {
    const md = claude('```', '/kanban-workflow <project> --gates manual', '/kanban-workflow <project> --gates auto-pr', '```');
    expect(startupPromptProblems(md, skill())).toContain(
      '2 slash-command invocations in CLAUDE.md\'s "Session startup" section — expected 1',
    );
  });

  it('keeps a `###` subsection inside its `##` section', () => {
    // The invocation lives under `### Recommending …` nested in `## Session startup`. A slicer that
    // ended the section at any heading would cut it off and report the invocation missing.
    const md = claude('### Recommending the skill', '', ...START);
    expect(startupPromptProblems(md, skill())).toEqual([]);
  });

  it('reports an UNPARSEABLE gate table rather than clearing the level check', () => {
    const bad = skill().replace('## 11–13. The gates', '## 11–13. The approvals');
    expect(startupPromptProblems(claude(...START), bad)).toContain(
      'no gate table parsed, so the recommended level could not be checked against it',
    );
  });

  it('refuses to name a safest level when the table has none', () => {
    const bad = skill().replace('| `manual` (default) | ask | ask | ask | ask |', '| `manual` (default) | ask | cross | ask | ask |');
    expect(startupPromptProblems(claude(...START), bad)).toContain(
      '0 gate levels ask at every gate, so "safest" is undecidable: []',
    );
  });

  // The SKILL.md side. Every case above mutates CLAUDE.md; with none of these, the checker returned
  // CLEAN for a SKILL.md whose handoff was gone, and nothing produced a `close handoff` message.
  it('reports a DELETED handoff invocation rather than returning clean', () => {
    expect(startupPromptProblems(claude(...START), skillWith('Print something helpful, then stop.')))
      .toContain('no slash-command invocation in SKILL.md\'s "The handoff" subsection');
  });

  it('reports a missing handoff SECTION rather than returning clean', () => {
    const bad = skill().replace('### The handoff', '### The parting words');
    expect(startupPromptProblems(claude(...START), bad))
      .toContain('no section found for SKILL.md\'s "The handoff" subsection');
  });

  it('refuses to guess between two invocations in the handoff', () => {
    const bad = skillWith('```', '/kanban-workflow <project> --gates manual', '/kanban-workflow <project> --gates auto-pr', '```');
    expect(startupPromptProblems(claude(...START), bad))
      .toContain('2 slash-command invocations in SKILL.md\'s "The handoff" subsection — expected 1');
  });

  it('flags a handoff carrying no --gates at all', () => {
    expect(startupPromptProblems(claude(...START), skill('/kanban-workflow <project>')))
      .toContain('the close handoff passes no `--gates` level');
  });

  it('flags a handoff pre-filling an auto level', () => {
    // Produces the `close handoff` safest-level message, which no CLAUDE.md-side fixture can reach.
    expect(startupPromptProblems(claude(...START), skill('/kanban-workflow <project> --gates auto-pr')))
      .toContain('the close handoff pre-fills `--gates auto-pr`, which does not ask at every gate; `manual` does');
  });

  it('does not truncate a section at a heading-shaped line inside a fenced block', () => {
    // A ```bash example whose body opens with `# ` used to end the slice, hiding the invocation below.
    const md = claude('```bash', '# how to resume', 'cd /somewhere && claude', '```', '', ...START);
    expect(startupPromptProblems(md, skill())).toEqual([]);
  });

  it('does not read a bare path as a slash-command invocation', () => {
    const md = claude('The API lives at', '', '```', '/api/tickets', '```', '', ...START);
    expect(startupPromptProblems(md, skill())).toEqual([]);
  });

  // tkt-71229c9290b8. The handoff now carries the next ticket id and the startup recommendation
  // still does not — a session opening cold has no ranking to carry. These pin that the asymmetry is
  // LEGAL; that it is also REQUIRED is asserted separately, by handoffTicketSlotProblems (deletion)
  // and startupTicketSlotProblems (bolting one on). Measured: these three alone leave a startup line
  // carrying a stray id fully green, so they are not that check and must not be read as it.
  it('tolerates a ticket id the handoff carries and the startup does not', () => {
    const withId = skill('/kanban-workflow kanban --gates manual tkt-0123456789ab');
    expect(startupPromptProblems(claude(...START), withId)).toEqual([]);
  });

  it('tolerates the id in either position around the flag', () => {
    const withId = skill('/kanban-workflow kanban tkt-0123456789ab --gates manual');
    expect(startupPromptProblems(claude(...START), withId)).toEqual([]);
  });

  it('still flags an auto level when an id is present — the id does not blind the level check', () => {
    // The negative control for the two cases above. Without it, their "clean" is equally explained
    // by a checker that stopped parsing AT the id, which would silently retire the level check the
    // moment the handoff started carrying one.
    const withId = skill('/kanban-workflow kanban --gates auto-pr tkt-0123456789ab');
    expect(startupPromptProblems(claude(...START), withId))
      .toContain('startup recommends `--gates manual` but the handoff prints `--gates auto-pr`');
  });
});

// tkt-ec08d8af98f3. §0 gained a ticket-id argument, so a run can be pointed at a known ticket
// instead of re-deriving the choice §4 exists to make. The argument surface is declared in TWO
// places — the frontmatter `argument-hint` and §0's bullet list — and nothing but this check binds
// them, so the failure to catch is one of them being edited alone: a hint promising `--ticket` that
// §0 no longer parses reads, from the invocation line, exactly like one that works.
//
// WHAT IS ASSERTED: §0 declares both accepted spellings — the canonical `--ticket <id>` flag and the
// bare `tkt-[0-9a-f]{12}` id shape, in PROSE and not merely inside a code fence — and that the
// file's opening frontmatter block names the flag. Same treatment §0's
// `--gates` already gets, and for the same reason: a spelling this file can parse is a spelling that
// cannot silently disappear.
//
// WHAT IS NOT ASSERTED: that a run parses an id, skips §4, or stops when §5 fails on a named ticket.
// Those are the consequential halves and they are prose an agent obeys — grepping §4/§5 for the
// words would be the ~2%-precision assertion-word probe CLAUDE.md measured and rejected. The
// declaration is the part that is structural; the behaviour stays honor-system, like the rest of §0.
export function ticketArgProblems(md) {
  const problems = [];
  const { section, headings } = sliceSection(md, 2, /\bparse\b/i);
  if (!section) {
    // Fail closed. A checker that returns clean because it found nothing to check is the fail-open
    // shape this repo rejects everywhere, and it is reachable by renaming one heading.
    problems.push(
      headings > 1
        ? `${headings} headings match §0 — cannot tell which section parses the arguments`
        : 'no §0 argument-parsing section found, so the ticket argument could not be checked',
    );
    return problems;
  }
  // sliceSection masks fences for HEADING detection only, so the returned lines still carry fenced
  // content. A §0 that has demoted both declarations to a historical example inside a ``` block is
  // documenting a rule it no longer applies — the same contamination adoption-markers.mjs strips.
  const body = section.filter((_, i) => !fenceMask(section)[i]).join('\n');
  if (!/`--ticket <id>`/.test(body)) {
    problems.push('§0 does not declare the canonical `--ticket <id>` spelling');
  }
  // Escaped because the id shape is itself written as a regex inside the markdown.
  if (!/`tkt-\[0-9a-f\]\{12\}`/.test(body)) {
    problems.push('§0 does not declare the bare `tkt-[0-9a-f]{12}` id shape');
  }
  // Anchored to the head of the file and stopped at the CLOSING delimiter. Unanchored, `^---`
  // matched any horizontal rule and the lazy body ran past the frontmatter to the first
  // line-initial `argument-hint:` anywhere in the file — so a hint moved out of frontmatter into
  // prose read as present while the invocation line no longer offered the flag.
  const fm = md.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const hint = fm ? fm[1].match(/^argument-hint:\s*(.+)$/m) : null;
  if (!hint) {
    problems.push('no `argument-hint` in the frontmatter, so the advertised argument surface is unchecked');
  } else if (!/--ticket/.test(hint[1])) {
    problems.push('the `argument-hint` does not name `--ticket`, so it promises a different argument surface than §0 parses');
  }
  return problems;
}

describe('kanban-workflow skill: ticket-id argument (tkt-ec08d8af98f3)', () => {
  it('declares both spellings in §0 and names the flag in the hint', () => {
    expect(ticketArgProblems(REAL)).toEqual([]);
  });

  it('slices a real §0 — so "no problems" cannot mean "nothing scanned"', () => {
    const { section, headings } = sliceSection(REAL, 2, /\bparse\b/i);
    expect(headings, 'exactly one §0 heading must match, or every assertion above passes vacuously').toBe(1);
    expect(section.join('\n')).toMatch(/--ticket/);
  });
});

describe('kanban-workflow skill: the ticket-argument checker itself', () => {
  const doc = (...bullets) => [
    '---',
    'name: kanban-workflow',
    'argument-hint: "<project> [<ticket-id>|--ticket <id>] [--continuous]"',
    '---',
    '',
    '## 0. Parse `$ARGUMENTS`',
    '',
    ...bullets,
    '',
    '## 1. Resolve the repos',
  ].join('\n');
  const BULLETS = [
    '- A token matching `tkt-[0-9a-f]{12}` → the **named ticket**.',
    '- `--ticket <id>` is the canonical spelling.',
  ];

  it('passes a well-formed fixture — so the flags below are not fired by everything', () => {
    expect(ticketArgProblems(doc(...BULLETS))).toEqual([]);
  });

  it('flags a dropped flag spelling', () => {
    expect(ticketArgProblems(doc(BULLETS[0]))).toContain('§0 does not declare the canonical `--ticket <id>` spelling');
  });

  it('flags a dropped bare-id shape', () => {
    expect(ticketArgProblems(doc(BULLETS[1]))).toContain('§0 does not declare the bare `tkt-[0-9a-f]{12}` id shape');
  });

  it('flags a hint that drifted from §0 — the half-edit this check exists for', () => {
    const md = doc(...BULLETS).replace('[<ticket-id>|--ticket <id>] ', '');
    expect(ticketArgProblems(md)).toContain(
      'the `argument-hint` does not name `--ticket`, so it promises a different argument surface than §0 parses',
    );
  });

  it('flags a missing argument-hint rather than passing it over', () => {
    const md = doc(...BULLETS).replace(/^argument-hint:.*$/m, 'description: does things');
    expect(ticketArgProblems(md)).toContain(
      'no `argument-hint` in the frontmatter, so the advertised argument surface is unchecked',
    );
  });

  it('reports a RENAMED §0 rather than returning clean', () => {
    const md = doc(...BULLETS).replace('## 0. Parse `$ARGUMENTS`', '## 0. Read the invocation');
    expect(ticketArgProblems(md)).toEqual([
      'no §0 argument-parsing section found, so the ticket argument could not be checked',
    ]);
  });

  it('refuses to guess when two sections match', () => {
    const md = doc(...BULLETS).replace('## 1. Resolve the repos', '## 1. Parse the rest\n\n## 2. Resolve the repos');
    expect(ticketArgProblems(md)).toEqual([
      '2 headings match §0 — cannot tell which section parses the arguments',
    ]);
  });

  it('does not count a declaration that survives only inside a code FENCE', () => {
    // The contamination path this repo already fixed once in scripts/probe/adoption-markers.mjs,
    // which strips fences "precisely so paperwork can never count as adoption". A §0 that has
    // demoted both declarations to a historical example parses as though they were still rules.
    const md = doc('Ticket arguments are no longer parsed. Historical example only:', '', '```', ...BULLETS, '```');
    expect(ticketArgProblems(md)).toContain('§0 does not declare the canonical `--ticket <id>` spelling');
  });

  it('reads the hint from the FRONTMATTER, not from a line-initial copy in the body', () => {
    // `^---` matches any horizontal rule, and a lazy body run past the closing delimiter finds the
    // first `argument-hint:` anywhere in the file — so a hint MOVED OUT of frontmatter into prose
    // left the advertised argument surface gone while this check stayed green.
    const md = doc(...BULLETS).replace(/^argument-hint:.*$/m, 'description: does things')
      + '\n\nThe hint used to read:\n\nargument-hint: "<project> [--ticket <id>]"\n';
    expect(ticketArgProblems(md)).toContain(
      'no `argument-hint` in the frontmatter, so the advertised argument surface is unchecked',
    );
  });

  it('requires frontmatter at the START of the file, not a stray rule', () => {
    const md = ['# Title', '', '---', '', '## 0. Parse `$ARGUMENTS`', '', ...BULLETS, '',
      'argument-hint: "<project> [--ticket <id>]"', '', '## 1. Next'].join('\n');
    expect(ticketArgProblems(md)).toContain(
      'no `argument-hint` in the frontmatter, so the advertised argument surface is unchecked',
    );
  });

  it('does not read a `---` block in the BODY as frontmatter', () => {
    // Distinguishes an anchored `^` from a multiline one: a pseudo-frontmatter block further down
    // the file is delimited exactly like the real thing, so only the anchor rejects it.
    const md = ['# Title', '', '---', 'argument-hint: "<project> [--ticket <id>]"', '---', '',
      '## 0. Parse `$ARGUMENTS`', '', ...BULLETS, '', '## 1. Next'].join('\n');
    expect(ticketArgProblems(md)).toContain(
      'no `argument-hint` in the frontmatter, so the advertised argument surface is unchecked',
    );
  });

  it('does not read a declaration from OUTSIDE §0', () => {
    // A `--ticket` mention that has drifted into a later section is not a parsing rule, and reading
    // one as though it were would let §0 lose the flag while this check stayed green.
    const md = doc(...BULLETS).replace(/^- `--ticket <id>`.*$/m, '- nothing here')
      + '\n\nLater on, pass `--ticket <id>` to name one.\n';
    expect(ticketArgProblems(md)).toContain('§0 does not declare the canonical `--ticket <id>` spelling');
  });
});

// ---------------------------------------------------------------------------
// tkt-71229c9290b8. §15's handoff now carries the NEXT ticket's id, so the incoming session skips
// §4's ranking instead of re-deriving one this session already had in hand. The whole capability is
// one token inside one templated line — precisely the shape an unrelated edit deletes without
// anyone noticing, leaving §15's surrounding prose describing a feature the template no longer has.
//
// WHAT IS ASSERTED: the handoff's single invocation carries a ticket SLOT, and (in the startup
// fixtures above) carrying one neither breaks the startup/handoff agreement nor blinds the
// gate-level check.
//
// WHAT IS NOT ASSERTED: that a run substitutes the slot, ranks the board correctly at close time,
// or omits the token when nothing is ready. Those are prose obligations in §15, and a word-grep for
// them would be the assertion-word probe CLAUDE.md measured at ~2% precision.

// A well-formed id, or an angle-bracket placeholder that names a ticket, in either spelling §0
// accepts. The placeholder branches are not laxity: SKILL.md is a template and is public, so a check
// demanding a literal `tkt-…` could only be satisfied by hardcoding one real ticket id into it.
// The `--ticket` alternative comes FIRST so it consumes its own argument — otherwise
// `--ticket tkt-…` would count as two slots and trip the doubled-id check below.
// It also carries the looser `<[^<>]+>` placeholder, because §0 calls `--ticket <id>` the canonical
// spelling and `<id>` does not contain the word "ticket" — the flag supplies that context.
const TICKET_SLOT_SRC = '(?:^|\\s)(?:--ticket\\s+(?:tkt-[0-9a-f]{12}|<[^<>]+>)'
  + '|tkt-[0-9a-f]{12}|<[^<>]*\\bticket\\b[^<>]*>)(?=\\s|$)';
const TICKET_SLOT = new RegExp(TICKET_SLOT_SRC);
const NO_SLOT_PROBLEM = 'the close handoff invocation carries no ticket slot, so it cannot pass the next ticket id';

export function handoffTicketSlotProblems(skillMd) {
  const handoff = invocationOf(skillMd, 3, /\bhandoff\b/i, 'SKILL.md\'s "The handoff" subsection');
  // Not `[]` — a handoff that could not be parsed is UNCHECKED, and reporting unchecked as fine is
  // the fail-open every other checker in this file refuses.
  if (handoff.problem) return [handoff.problem];
  // Counted, not merely tested: §0 stops outright on two ticket ids, so a template carrying two
  // would hand every future session a guaranteed stop — a slot check that only asked "is there one?"
  // reports that as healthy.
  const slots = handoff.invocation.rest.match(new RegExp(TICKET_SLOT_SRC, 'g')) ?? [];
  if (slots.length === 0) return [NO_SLOT_PROBLEM];
  if (slots.length > 1) {
    return [`the close handoff invocation carries ${slots.length} ticket slots — §0 stops on two ids`];
  }
  return [];
}

// tkt-71229c9290b8, review finding 4. The asymmetry is stated as fact in CLAUDE.md's Project
// structure bullet, so it owes an assertion rather than a comment: the DELETION half was pinned by
// the checker above, while bolting a meaningless id onto the startup line stayed green. A cold
// session has no prior run to rank from, so an id there could only ever be a guess.
export function startupTicketSlotProblems(claudeMd) {
  const startup = invocationOf(claudeMd, 2, /session startup/i, 'CLAUDE.md\'s "Session startup" section');
  if (startup.problem) return [startup.problem];
  if (TICKET_SLOT.test(startup.invocation.rest)) {
    return ['the startup recommendation carries a ticket slot, but a cold session has no ranking to carry'];
  }
  return [];
}

describe('kanban-workflow skill: handoff ticket slot (tkt-71229c9290b8)', () => {
  it('the real handoff carries a ticket slot', () => {
    expect(handoffTicketSlotProblems(REAL)).toEqual([]);
  });
});

describe('kanban-workflow skill: the ticket-slot checker itself', () => {
  const skillWith = (...handoff) => [
    '## 15. Close the ticket — wrap-up check, then the handoff',
    '',
    '### The handoff',
    '',
    ...handoff,
    '',
    '## 16. Loop or stop',
  ].join('\n');
  const skill = (invocation) => skillWith('```', invocation, '```');
  const NO_SLOT = 'the close handoff invocation carries no ticket slot, so it cannot pass the next ticket id';

  it('passes a slot-carrying handoff — so the flags below are not fired by everything', () => {
    expect(handoffTicketSlotProblems(skill('/kanban-workflow <project> --gates manual <next ticket id>'))).toEqual([]);
  });

  it('accepts a substituted, well-formed id', () => {
    expect(handoffTicketSlotProblems(skill('/kanban-workflow kanban --gates manual tkt-0123456789ab'))).toEqual([]);
  });

  it('flags a handoff whose ticket slot was DELETED', () => {
    expect(handoffTicketSlotProblems(skill('/kanban-workflow <project> --gates manual'))).toEqual([NO_SLOT]);
  });

  it('does not accept just any angle-bracket placeholder as the slot', () => {
    // `<project>` sits beside the ticket slot in the real template, so a check matching any
    // angle-bracket token would stay green after the ticket one was removed.
    expect(handoffTicketSlotProblems(skill('/kanban-workflow <project> --gates manual <id>'))).toEqual([NO_SLOT]);
  });

  it('does not accept a MALFORMED id as the slot', () => {
    // §0 stops on a `tkt-`-prefixed token that is not well formed, so a handoff printing one hands
    // the next session a guaranteed stop. Same shape rule as §0 parses by.
    expect(handoffTicketSlotProblems(skill('/kanban-workflow <project> --gates manual tkt-abc'))).toEqual([NO_SLOT]);
  });

  it('does not read a slot out of PROSE beside an invocation that lost it', () => {
    // The failure this is the control for: §15 keeps explaining how to substitute the id long after
    // the template stopped having one, which reads correct to a human skimming the section.
    const md = skillWith('```', '/kanban-workflow <project> --gates manual', '```', '',
      'Substitute `<next ticket id>` before printing.');
    expect(handoffTicketSlotProblems(md)).toEqual([NO_SLOT]);
  });

  it('reports a MISSING handoff section rather than returning clean', () => {
    const md = ['## 15. Close', '', 'No handoff here.', '', '## 16. Loop or stop'].join('\n');
    expect(handoffTicketSlotProblems(md)).toEqual(['no section found for SKILL.md\'s "The handoff" subsection']);
  });

  it('reports a handoff with NO invocation rather than returning clean', () => {
    expect(handoffTicketSlotProblems(skillWith('Just go back to the board.')))
      .toEqual(['no slash-command invocation in SKILL.md\'s "The handoff" subsection']);
  });

  it('accepts the canonical `--ticket <id>` spelling from §0', () => {
    // §0 calls this the canonical spelling, so a future editor aligning the handoff with it must
    // not get a red suite claiming the handoff "carries no ticket slot" when it plainly does.
    expect(handoffTicketSlotProblems(skill('/kanban-workflow <project> --gates manual --ticket <id>'))).toEqual([]);
  });

  it('counts `--ticket tkt-…` as ONE slot, not two', () => {
    // The flag alternative must consume its own argument; if it did not, the canonical spelling
    // would trip the doubled-id check below and the fix for one finding would cause another.
    expect(handoffTicketSlotProblems(skill('/kanban-workflow kanban --gates manual --ticket tkt-0123456789ab'))).toEqual([]);
  });

  it('flags TWO ticket ids, which §0 stops on outright', () => {
    // A template carrying two hands every future session a guaranteed stop. A check that only
    // asked "is there a slot?" reports that as healthy — hence counting rather than testing.
    expect(handoffTicketSlotProblems(skill('/kanban-workflow kanban --gates manual tkt-0123456789ab tkt-ba9876543210')))
      .toEqual(['the close handoff invocation carries 2 ticket slots — §0 stops on two ids']);
  });

  it('flags an UPPERCASE or non-hex id, which §0 does not accept either', () => {
    expect(handoffTicketSlotProblems(skill('/kanban-workflow kanban --gates manual tkt-0123456789AB'))).toEqual([NO_SLOT]);
  });

  it('flags an OVER-LONG id rather than matching its well-formed prefix', () => {
    // The `(?=\s|$)` lookahead is what makes this red; without it the regex would match the first
    // 12 hex characters of a longer token and call a malformed id healthy.
    expect(handoffTicketSlotProblems(skill('/kanban-workflow kanban --gates manual tkt-0123456789abcdef'))).toEqual([NO_SLOT]);
  });

  it('reports TWO handoff headings rather than resolving them by position', () => {
    // The fail-closed branch of the shared invocationOf, asserted here for THIS checker: nothing
    // else pins that an ambiguous section reaches the caller as a problem rather than as clean.
    const md = [
      '## 15. Close', '', '### The handoff', '', '```',
      '/kanban-workflow <project> --gates manual <next ticket id>', '```', '',
      '### The handoff, continued', '', '## 16. Loop or stop',
    ].join('\n');
    expect(handoffTicketSlotProblems(md))
      .toEqual(['2 headings match SKILL.md\'s "The handoff" subsection — cannot tell which section carries the invocation']);
  });

  it('reports a SECOND invocation rather than picking the one that happens to carry a slot', () => {
    // The no-candidate case is prose in §15 for exactly this reason: a second worked example turns
    // the contract red, and a slot check that scanned for "any invocation with an id" would hide it.
    const md = skillWith('```', '/kanban-workflow <project> --gates manual <next ticket id>', '```', '',
      'When the board has nothing ready:', '', '```', '/kanban-workflow <project> --gates manual', '```');
    expect(handoffTicketSlotProblems(md))
      .toEqual(['2 slash-command invocations in SKILL.md\'s "The handoff" subsection — expected 1']);
  });
});

describe('kanban-workflow skill: startup carries NO ticket slot (tkt-71229c9290b8)', () => {
  it('the real startup recommendation carries no ticket slot', () => {
    expect(startupTicketSlotProblems(REAL_CLAUDE)).toEqual([]);
  });
});

describe('kanban-workflow skill: the startup-slot checker itself', () => {
  const claude = (...body) => [
    '# Kanban Project', '', '## Session startup (MANDATORY)', '', ...body, '', '## MCP server',
  ].join('\n');

  it('passes a slot-free startup — so the flags below are not fired by everything', () => {
    expect(startupTicketSlotProblems(claude('```', '/kanban-workflow <project> --gates manual', '```'))).toEqual([]);
  });

  it('flags an id bolted onto the startup line', () => {
    // The half that was green before this checker existed, while a comment two files away claimed
    // it could not be. A cold session has no prior run to rank from, so the id could only be a guess.
    expect(startupTicketSlotProblems(claude('```', '/kanban-workflow kanban --gates manual tkt-0123456789ab', '```')))
      .toEqual(['the startup recommendation carries a ticket slot, but a cold session has no ranking to carry']);
  });

  it('flags a placeholder slot too, not only a substituted id', () => {
    expect(startupTicketSlotProblems(claude('```', '/kanban-workflow <project> --gates manual <next ticket id>', '```')))
      .not.toEqual([]);
  });

  it('reports a MISSING startup section rather than returning clean', () => {
    const md = ['# Kanban Project', '', '## MCP server', '', 'nothing here'].join('\n');
    expect(startupTicketSlotProblems(md))
      .toEqual(['no section found for CLAUDE.md\'s "Session startup" section']);
  });
});
