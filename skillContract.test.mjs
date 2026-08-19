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
    .map((m) => ({ skill: m[1], gates: (m[2].match(/--gates\s+(\S+)/) || [])[1] ?? null }));
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
});
