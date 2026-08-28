import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Binds the /kanban-workflow skill's SKILL.md to this repo's CLAUDE.md. Five surfaces survive the
// tkt-5a4ff25d4e74 trim, kept by one rule: a drift in each would be SILENT. The rest were dropped
// because a run stops or degrades visibly instead — see docs/skillContract-dropped-assertions.md
// for what went, why, how to restore it, and the two the first cut dropped wrongly.
//
// NOT asserted: that a RUN obeys any of it. Nothing here observes a session, and in foreign mode
// this suite never runs. A word-grep over the prose would be the assertion-word probe CLAUDE.md
// measured at ~2% precision — deliberately absent rather than approximated.

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = path.join(here, '.claude', 'skills', 'kanban-workflow', 'SKILL.md');
const CLAUDE_PATH = path.join(here, 'CLAUDE.md');

const stripMarkup = (cell) => cell.replace(/[*`]/g, '').trim();
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

// `| \`manual\` (default) |` names the level `manual`; the parenthetical is prose.
const levelLabel = (cell) => stripMarkup(cell).replace(/\s*\(.*\)\s*/, '').trim();

// `**ask — always**` is the value `ask` with an emphasis qualifier. The dash form requires a
// FOLLOWING space so a hyphenated token is never split.
const gateValue = (cell) => stripMarkup(cell)
  .replace(/\s*\(.*\)\s*$/, '')
  .replace(/\s*[—–-]\s.*$/, '')
  .trim()
  .toLowerCase();

// A fenced line is never a heading, and never a table row. Every parser below masks with it: a
// ```bash block whose body opens with `# ` would otherwise truncate a section slice, and a fenced
// EXAMPLE table would parse as the real one. Measured on the gate table before this was threaded
// through parseSkill/parseMenu: deleting the real §11–13 table and leaving a ```markdown copy of it
// returned NO problems (tkt-5a4ff25d4e74 review, finding 4).
function fenceMask(lines) {
  let inFence = false;
  return lines.map((l) => {
    if (/^\s*(?:```|~~~)/.test(l)) { inFence = !inFence; return true; }
    return inFence;
  });
}

// ---------------------------------------------------------------------------
// Gate table (tkt-abaff4ebd8b3)

// An ALLOWLIST per gate, not a denylist of skip words: a denylist measured false-clean on both
// halves of the real invariant (a dropped `merge` column, and `cross` for merge).
// Adding a gate or a value here must be a deliberate edit, which is the point.
const GATE_VALUES = {
  review: ['ask', 'run'],
  commit: ['ask', 'cross'],
  'pr open': ['ask', 'cross'],
  // Human in every mode. There is deliberately no `cross` here.
  merge: ['ask'],
};
// Order is load-bearing: the review resolves BEFORE the commit, and that has been "corrected"
// backwards once already (see CLAUDE.md's note on it).
const COLUMNS = ['level', ...Object.keys(GATE_VALUES)];

// Second layer, not redundant: a qualified crossing like `ask — but skip when docs-only` normalizes
// to `ask` and clears the allowlist. Unanchored on purpose — an anchored `^…$` let three shapes through.
const SKIP_WORD = /\b(?:skip(?:s|ped)?|none|n\/?a|optional|waive[ds]?|never)\b/i;

function parseSkill(md) {
  const lines = md.split('\n');
  const fenced = fenceMask(lines);
  // The flag must come from prose too, or a fenced worked example supplies the level set for a file
  // that no longer declares one.
  const flagIdx = lines.findIndex((l, i) => !fenced[i] && /`--gates [^`]+`/.test(l));
  const flag = flagIdx === -1 ? null : lines[flagIdx].match(/`--gates ([^`]+)`/);
  const levels = flag ? flag[1].split('|').map((s) => s.trim()) : null;

  const gateHeadings = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => !fenced[i] && /^##\s/.test(line) && /\bgates\b/i.test(line));
  // Ambiguity is reported, never resolved by position: binding to the FIRST match would let a later
  // "…gates…" section silently retarget the parser.
  if (gateHeadings.length !== 1) return { levels, table: null, gateHeadings: gateHeadings.length };

  const from = gateHeadings[0].i + 1;
  const rest = lines.slice(from);
  const restFenced = fenced.slice(from);
  const endRel = rest.findIndex((l, i) => !restFenced[i] && /^##\s/.test(l));
  const section = endRel === -1 ? rest : rest.slice(0, endRel);
  const sectionFenced = endRel === -1 ? restFenced : restFenced.slice(0, endRel);

  const rows = section.filter((l, i) => !sectionFenced[i] && l.trimStart().startsWith('|'));
  if (rows.length < 3) return { levels, table: null, gateHeadings: 1 }; // header + separator + a level
  return {
    levels,
    gateHeadings: 1,
    table: {
      columns: splitRow(rows[0]).map((c) => stripMarkup(c).toLowerCase()),
      body: rows.slice(2).map(splitRow), // rows[1] is the `|---|` separator
    },
  };
}

function gateTableProblems(md) {
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

// ---------------------------------------------------------------------------
// Gate-level menu (tkt-34f8a4b467e7) — the list §0 renders when `--gates` is omitted.

// Bound to the section that DECLARES the flag, not a heading name: a menu that drifts away from the
// flag it documents is reported, never hunted for.
function parseMenu(md) {
  const lines = md.split('\n');
  const fenced = fenceMask(lines);
  const flagIdx = lines.findIndex((l, i) => !fenced[i] && /`--gates [^`]+`/.test(l));
  if (flagIdx === -1) return null;
  let start = flagIdx;
  while (start > 0 && !(!fenced[start] && /^##\s/.test(lines[start]))) start -= 1;
  // A flag in an unheaded prologue has no heading to step past; slicing past index 0 anyway would
  // drop a menu entry sitting on the first line.
  const headed = !fenced[start] && /^##\s/.test(lines[start]);
  const from = headed ? start + 1 : start;
  const rest = lines.slice(from);
  const restFenced = fenced.slice(from);
  const endRel = rest.findIndex((l, i) => !restFenced[i] && /^##\s/.test(l));
  const section = endRel === -1 ? rest : rest.slice(0, endRel);
  const sectionFenced = endRel === -1 ? restFenced : restFenced.slice(0, endRel);

  const entries = [];
  for (const [i, line] of section.entries()) {
    if (sectionFenced[i]) continue; // a fenced example menu is not the menu
    // The em dash separates an option from the flag bullets above it, which use `→`.
    const m = line.match(/^-\s+`([^`]+)`\s*(\(Recommended\))?\s*—\s*(.*)$/);
    if (m) entries.push({ level: m[1].trim(), recommended: Boolean(m[2]), description: m[3].trim() });
  }
  return entries;
}

// DERIVED from the gate table, never named here. Hardcoding `manual` would let the table and the
// two prompts drift apart in three directions at once.
function safestLevels(table) {
  return table.body
    // `[].every()` is true, so without this a row specifying NO gates reads as asking at all of them.
    .filter((cells) => cells.length === table.columns.length)
    .filter((cells) => cells.slice(1).every((c) => gateValue(c) === 'ask'))
    .map((cells) => levelLabel(cells[0]));
}

function gateMenuProblems(md) {
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

  // Set comparison clears a level offered twice, while the menu renders two contradicting options.
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
    // An unparseable table means the most consequential half did not run; returning clean would
    // report "not checked" as "checked and fine".
    problems.push('no gate table parsed, so the recommendation could not be checked against it');
  } else {
    const safest = safestLevels(table);
    // No level asking everywhere, or two, cannot say which is safest — report rather than pick.
    if (safest.length !== 1) {
      problems.push(`${safest.length} gate levels ask at every gate, so "safest" is undecidable: [${safest.join(', ')}]`);
    } else if (recommended[0].level !== safest[0]) {
      // NOT "crosses a gate": `run` pre-authorizes running the review, it crosses nothing. What
      // disqualifies a level is asking less.
      problems.push(`the menu recommends \`${recommended[0].level}\`, which does not ask at every gate; \`${safest[0]}\` does`);
    }
  }

  // The first option is what a hurried reader takes, so its position is part of the default.
  if (recommended.length === 1 && named[0] !== recommended[0].level) {
    problems.push(`the recommended level \`${recommended[0].level}\` is not the first menu entry (\`${named[0]}\` is)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Post-review table (tkt-32f7c384bcad) — §10's checks a run owes before `record_review`. A review
// misdirected at another repo returns an EMPTY finding list, byte-identical to a clean one. "Name
// the target repo" is prose, i.e. prevention only; this table is the only DETECTION half.

// `did not run` only, matched EXACTLY — normalization in front of the allowlist measured CLEAN on
// two exemption shapes. A denylist of qualifier words is unclosable by construction (SKIP_WORD knew
// `optional`, not `unless`/`except`), which is why this matches rather than denies.
const SCOPE_VALUES = {
  'when it cannot be confirmed': ['did not run'],
};
const SCOPE_COLUMNS = ['check', ...Object.keys(SCOPE_VALUES)];
// Neither subsumes the other: `finders ran` catches dead agents, `scope` catches the wrong repo.
const SCOPE_CHECKS = ['finders ran', 'scope'];
// Deliberately NOT levelLabel()/gateValue(): stripping a trailing `(…)`/`— …` before the allowlist
// sees the cell is how an exemption bolted onto a row name passed clean. Any residue is a defect.
const cellText = (cell) => stripMarkup(cell).toLowerCase();

function parseScopeTable(md) {
  const lines = md.split('\n');
  const fenced = fenceMask(lines);
  const headings = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => !fenced[i] && /^##\s/.test(line) && /\breview\b/i.test(line));
  if (headings.length !== 1) return { table: null, headings: headings.length };

  const from = headings[0].i + 1;
  const rest = lines.slice(from);
  const restFenced = fenced.slice(from);
  const endRel = rest.findIndex((l, i) => !restFenced[i] && /^##\s/.test(l));
  const section = endRel === -1 ? rest : rest.slice(0, endRel);
  const sectionFenced = endRel === -1 ? restFenced : restFenced.slice(0, endRel);

  const rows = section.filter((l, i) => !sectionFenced[i] && l.trimStart().startsWith('|'));
  if (rows.length < 3) return { table: null, headings: 1 };
  return {
    table: {
      columns: splitRow(rows[0]).map((c) => stripMarkup(c).toLowerCase()),
      body: rows.slice(2).map(splitRow),
    },
    headings: 1,
  };
}

function scopeTableProblems(md) {
  const problems = [];
  const { table, headings } = parseScopeTable(md);
  if (!table) {
    problems.push(
      headings > 1
        ? `${headings} headings match "review" — cannot tell which table is the post-review table`
        : 'no post-review table found under a "review" heading',
    );
    return problems;
  }

  const { columns, body } = table;
  if (columns.join(' | ') !== SCOPE_COLUMNS.join(' | ')) {
    problems.push(`post-review columns are [${columns.join(', ')}], expected [${SCOPE_COLUMNS.join(', ')}]`);
  }

  const named = body.map((cells) => cellText(cells[0]));
  const missing = SCOPE_CHECKS.filter((c) => !named.includes(c));
  const extra = named.filter((c) => !SCOPE_CHECKS.includes(c));
  if (missing.length) problems.push(`post-review checks with no row: ${missing.join(', ')}`);
  if (extra.length) problems.push(`post-review rows naming no known check: ${extra.join(', ')}`);
  const repeated = [...new Set(named.filter((c, i) => named.indexOf(c) !== i))];
  if (repeated.length) problems.push(`post-review checks with more than one row: ${repeated.join(', ')}`);

  for (const cells of body) {
    const check = cellText(cells[0]);
    for (let i = 1; i < columns.length; i += 1) {
      const column = columns[i];
      const allowed = SCOPE_VALUES[column];
      if (!allowed) continue; // unknown column already reported above
      const raw = cells[i] ?? '';
      if (!allowed.includes(cellText(raw))) {
        problems.push(`${check}'s ${column} value is "${raw.trim() || '<empty>'}", expected one of ${allowed.join('/')}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Startup recommendation <-> close handoff (tkt-9fbe6c952590) — the same invocation printed at the
// two ends of a session, in two files nothing otherwise ties together. "Keep these in sync" is not a
// mechanism (CLAUDE.md, "Generate, don't transcribe"), so the agreement is asserted here.

// Slices by heading DEPTH: a same-or-shallower heading closes the slice, deeper ones are part of it
// (`### Recommending` lives inside `## Session startup`).
function sliceSection(md, depth, nameRe) {
  const lines = md.split('\n');
  const fenced = fenceMask(lines);
  const opens = new RegExp(`^#{${depth}}\\s`);
  const closes = new RegExp(`^#{1,${depth}}\\s`);
  const heads = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => !fenced[i] && opens.test(line) && nameRe.test(line));
  if (heads.length !== 1) return { section: null, headings: heads.length };
  const start = heads[0].i + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (!fenced[i] && closes.test(lines[i])) { end = i; break; }
  }
  return { section: lines.slice(start, end), headings: 1 };
}

// Line-initial only, excluding inline prose mentions (a file whose invocation was DELETED would
// otherwise parse off a sentence naming the skill) and paths like `/api/tickets`.
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
  // Two invocations can disagree; comparing whichever came first would clear that.
  if (found.length > 1) {
    return { invocation: null, problem: `${found.length} slash-command invocations in ${where} — expected 1` };
  }
  return { invocation: found[0], problem: null };
}

function startupPromptProblems(claudeMd, skillMd) {
  const problems = [];
  const startup = invocationOf(claudeMd, 2, /session startup/i, "CLAUDE.md's \"Session startup\" section");
  const handoff = invocationOf(skillMd, 3, /\bhandoff\b/i, "SKILL.md's \"The handoff\" subsection");
  if (startup.problem) problems.push(startup.problem);
  if (handoff.problem) problems.push(handoff.problem);
  // Two MISSING invocations are trivially "equal"; reporting that as agreement is the fail-open.
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
    problems.push('no gate table parsed, so the recommended level could not be checked against it');
    return problems;
  }
  const safest = safestLevels(table);
  if (safest.length !== 1) {
    problems.push(`${safest.length} gate levels ask at every gate, so "safest" is undecidable: [${safest.join(', ')}]`);
    return problems;
  }
  // Both sides: looping over the startup alone let a handoff pre-filling an auto level through.
  for (const [name, side] of [['startup recommendation', startup], ['close handoff', handoff]]) {
    if (side.invocation.gates !== safest[0]) {
      problems.push(
        `the ${name} pre-fills \`--gates ${side.invocation.gates}\`, which does not ask at every gate; \`${safest[0]}\` does`,
      );
    }
  }
  return problems;
}

// The startup line must carry NO ticket slot (tkt-71229c9290b8). Kept when the handoff half of this
// binding was dropped: the drop rationale — "a pasted id is a guess, and §5 catches it" — holds only
// for a STALE id. A valid one passes §5, and §0's named-ticket path then skips §4's ranking, so every
// session opened from that prompt silently works a ticket nobody chose (tkt-5a4ff25d4e74 review,
// finding 6). The handoff's own slot has no such failure: losing it costs one re-ranking, visibly.
const TICKET_SLOT = new RegExp('(?:^|\\s)(?:--ticket\\s+(?:tkt-[0-9a-f]{12}|<[^<>]+>)'
  + '|tkt-[0-9a-f]{12}|<[^<>]*\\bticket\\b[^<>]*>)(?=\\s|$)');

function startupTicketSlotProblems(claudeMd) {
  const startup = invocationOf(claudeMd, 2, /session startup/i, 'CLAUDE.md\'s "Session startup" section');
  // Not `[]` — an unparseable startup is UNCHECKED, and reporting unchecked as fine is the fail-open
  // every other checker here refuses.
  if (startup.problem) return [startup.problem];
  if (TICKET_SLOT.test(startup.invocation.rest)) {
    return ['the startup recommendation carries a ticket slot, but a cold session has no ranking to carry'];
  }
  return [];
}

// ---------------------------------------------------------------------------
// The real files.

const REAL = fs.readFileSync(SKILL_PATH, 'utf8');
const REAL_CLAUDE = fs.readFileSync(CLAUDE_PATH, 'utf8');

describe('kanban-workflow skill: the real SKILL.md and CLAUDE.md', () => {
  it('parses a real gate table, menu, post-review table and both invocations', () => {
    // Non-vacuity for everything below: without this, "no problems" and "nothing scanned" are the
    // same result.
    const { levels, table } = parseSkill(REAL);
    expect(levels, 'the `--gates` flag line is what every row/entry set is checked against').toEqual(
      ['manual', 'auto-commit', 'auto-pr'],
    );
    expect(table, 'no gate table parsed').not.toBeNull();
    expect(table.columns).toEqual(COLUMNS);
    expect(table.body.length).toBe(levels.length);

    expect(parseMenu(REAL)?.map((e) => e.level)).toEqual(levels);

    const { table: scope } = parseScopeTable(REAL);
    expect(scope, 'no post-review table parsed').not.toBeNull();
    expect(scope.columns).toEqual(SCOPE_COLUMNS);
    expect(scope.body.length).toBe(SCOPE_CHECKS.length);

    expect(invocationOf(REAL_CLAUDE, 2, /session startup/i, 'startup').problem).toBeNull();
    expect(invocationOf(REAL, 3, /\bhandoff\b/i, 'handoff').problem).toBeNull();
  });

  it('carries a review gate no level can skip', () => {
    expect(gateTableProblems(REAL)).toEqual([]);
  });

  it('keeps merge human at every level', () => {
    const { table } = parseSkill(REAL);
    const merge = table.columns.indexOf('merge');
    expect(table.body.map((cells) => gateValue(cells[merge]))).toEqual(table.body.map(() => 'ask'));
  });

  it('offers every level, described, and recommends the one that asks at every gate', () => {
    expect(gateMenuProblems(REAL)).toEqual([]);
  });

  it('carries a scope check that cannot resolve permissively when it cannot be confirmed', () => {
    expect(scopeTableProblems(REAL)).toEqual([]);
    const { table } = parseScopeTable(REAL);
    const col = table.columns.indexOf('when it cannot be confirmed');
    expect(table.body.map((cells) => cellText(cells[col]))).toEqual(table.body.map(() => 'did not run'));
  });

  it('opens and closes a session with the same invocation, at a level that crosses nothing', () => {
    expect(startupPromptProblems(REAL_CLAUDE, REAL)).toEqual([]);
    const { invocation } = invocationOf(REAL_CLAUDE, 2, /session startup/i, 'startup');
    const { table } = parseSkill(REAL);
    expect(safestLevels(table)).toEqual([invocation.gates]);
  });

  it('carries no ticket slot on the startup line', () => {
    expect(startupTicketSlotProblems(REAL_CLAUDE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Controls on the checkers. Each negative case pins either a MEASURED past false-clean or the
// "cannot check must not read as clean" direction — not every shape a parser could mishandle. The
// cases the trim dropped, and the incidents behind the ones kept, are in
// docs/skillContract-dropped-assertions.md.

const FLAG = '- `--gates manual|auto-commit|auto-pr` → default **`manual`**.\n\n';
const HEADER = '| level | review | commit | PR open | merge |';
const GOOD = [
  '| `manual` (default) | ask | ask | ask | ask |',
  '| `auto-commit` | run | cross | ask | ask |',
  '| `auto-pr` | run | cross | cross | **ask — always** |',
];
const gateDoc = (header, ...rows) =>
  ['## 11–13. The gates', '', header, '|---|---|---|---|---|', ...rows, '', '## 14. Next'].join('\n');

describe('the gate-table checker itself', () => {
  it('passes a correct table — so the flags below are not fired by everything', () => {
    expect(gateTableProblems(FLAG + gateDoc(HEADER, ...GOOD))).toEqual([]);
  });

  it('flags a table with no review column', () => {
    const md = FLAG + gateDoc(
      '| level | commit | PR open | merge |',
      '| `manual` (default) | ask | ask | ask |',
      '| `auto-commit` | cross | ask | ask |',
      '| `auto-pr` | cross | cross | **ask — always** |',
    );
    expect(gateTableProblems(md)).toContain(
      'gate columns are [level, commit, pr open, merge], expected [level, review, commit, pr open, merge]',
    );
  });

  it('flags a review cell that skips', () => {
    const md = FLAG + gateDoc(HEADER, GOOD[0], GOOD[1], '| `auto-pr` | skip | cross | cross | ask |');
    expect(gateTableProblems(md)).toContain('auto-pr\'s review value is "skip", expected one of ask/run');
  });

  // Both halves measured CLEAN against the first cut, which checked only "no cell says skip".
  it('flags a DROPPED merge column, not just a bad merge value', () => {
    const md = FLAG + gateDoc(
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
    const md = FLAG + gateDoc(HEADER, GOOD[0], GOOD[1], '| `auto-pr` | run | cross | cross | cross |');
    expect(gateTableProblems(md)).toContain('auto-pr\'s merge value is "cross", expected one of ask');
  });

  // These three passed the first cut's ANCHORED `^…$` matcher.
  it('flags qualified and parenthesised skips an anchored matcher let through', () => {
    const na = FLAG + gateDoc(HEADER, '| `manual` (default) | n/a (docs-only) | ask | ask | ask |', GOOD[1], GOOD[2]);
    expect(gateTableProblems(na)).toContain('manual\'s review value is "n/a (docs-only)", expected one of ask/run');
    const opt = FLAG + gateDoc(HEADER, '| `manual` (default) | optional — see §14 | ask | ask | ask |', GOOD[1], GOOD[2]);
    expect(gateTableProblems(opt)).toContain('manual\'s review value is "optional — see §14", expected one of ask/run');
    const qual = FLAG + gateDoc(HEADER, GOOD[0], GOOD[1], '| `auto-pr` | run | cross | ask — skip if docs-only | ask |');
    expect(gateTableProblems(qual)).toContain('auto-pr may skip the pr open gate ("ask — skip if docs-only")');
  });

  it('reports a missing table rather than returning clean', () => {
    expect(gateTableProblems('# nothing here')).toContain('no gate table found under a "gates" heading');
  });

  it('refuses to guess when two headings match "gates"', () => {
    const md = FLAG + '## 3. Board gates\n\n| a | b |\n|---|---|\n| x | y |\n\n' + gateDoc(HEADER, ...GOOD);
    expect(gateTableProblems(md)).toContain('2 headings match "gates" — cannot tell which table is the gate table');
  });

  it('reports a FENCED example table as no table, rather than as the real one', () => {
    // Measured returning [] before fenceMask was threaded through parseSkill: the real table deleted,
    // a ```markdown copy of it left behind, and the most consequential binding read CLEAN.
    const fencedOnly = FLAG + ['## 11–13. The gates', '', '```markdown', HEADER, '|---|---|---|---|---|',
      ...GOOD, '```', '', '## 14. Next'].join('\n');
    expect(gateTableProblems(fencedOnly)).toContain('no gate table found under a "gates" heading');
  });
});

describe('the gate-menu checker itself', () => {
  const MENU = [
    '- `manual` (Recommended) — every gate asks.',
    '- `auto-commit` — commits without asking; PR-open and merge still ask.',
    '- `auto-pr` — commits and opens the PR without asking; merge still asks.',
  ];
  const doc = (...menu) => [
    '## 0. Parse `$ARGUMENTS`',
    '',
    FLAG.trim(),
    '',
    ...menu,
    '',
    gateDoc(HEADER, ...GOOD),
  ].join('\n');

  it('passes a correct menu — so the flags below are not fired by everything', () => {
    expect(gateMenuProblems(doc(...MENU))).toEqual([]);
  });

  it('flags a recommendation on a level that crosses a gate', () => {
    const md = doc('- `auto-pr` (Recommended) — commits and opens the PR without asking.', '- `manual` — every gate asks.', MENU[1]);
    expect(gateMenuProblems(md)).toContain('the menu recommends `auto-pr`, which does not ask at every gate; `manual` does');
  });

  it('flags two recommendations, which is no recommendation', () => {
    expect(gateMenuProblems(doc(MENU[0], '- `auto-commit` (Recommended) — commits for you.', MENU[2])))
      .toContain('the menu marks 2 entries (Recommended), expected exactly 1: manual, auto-commit');
  });

  it('reports an UNPARSEABLE gate table rather than clearing the recommendation', () => {
    // A review found this returning [] for a menu recommending auto-pr: not checked, read as fine.
    const bad = doc('- `auto-pr` (Recommended) — commits and opens the PR without asking.', '- `manual` — every gate asks.', MENU[1])
      .replace('## 11–13. The gates', '## 11–13. The approvals');
    expect(gateMenuProblems(bad)).toContain('no gate table parsed, so the recommendation could not be checked against it');
  });

  it('does not treat a row with no gate cells as the level that asks at every gate', () => {
    // `[].every()` is true, so a truncated row read as all-ask.
    const md = doc(...MENU).replace('| `manual` (default) | ask | ask | ask | ask |', '| `manual` (default) |');
    expect(gateMenuProblems(md)).toContain('0 gate levels ask at every gate, so "safest" is undecidable: []');
  });

  it('flags a recommendation that is not the first option', () => {
    // The first option is what a hurried reader takes, so a menu listing `auto-pr` first with
    // `manual` marked lower down pre-authorizes crossing commit AND PR-open, indistinguishably from
    // a correct menu at the point of use. Silent drift — it belongs with the kept set.
    expect(gateMenuProblems(doc(MENU[1], MENU[0], MENU[2])))
      .toContain('the recommended level `manual` is not the first menu entry (`auto-commit` is)');
  });

  it('reports a missing menu rather than returning clean', () => {
    expect(gateMenuProblems(doc())).toContain('no gate-level menu found in the section that declares `--gates`');
  });

  it('does not read a FENCED example menu as the menu', () => {
    expect(gateMenuProblems(doc('```markdown', ...MENU, '```')))
      .toContain('no gate-level menu found in the section that declares `--gates`');
  });
});

describe('the post-review checker itself', () => {
  const ROWS = [
    '| check | when it cannot be confirmed |',
    '|---|---|',
    ...SCOPE_CHECKS.map((c) => `| **${c}** | did not run |`),
  ];
  const doc = (...rows) => ['## 10. Review — calibrated, and stated', '', ...rows, '', '## 11–13. The gates'].join('\n');
  const withScope = (row) => doc(...ROWS.map((r) => (r.includes('**scope**') ? row : r)));

  it('passes a correct table — so the flags below are not fired by everything', () => {
    expect(scopeTableProblems(doc(...ROWS))).toEqual([]);
  });

  it('flags a DROPPED scope row — the whole point of this binding', () => {
    expect(scopeTableProblems(doc(...ROWS.filter((r) => !r.includes('**scope**')))))
      .toContain('post-review checks with no row: scope');
  });

  it('flags a check that resolves to a clean review when it cannot be confirmed', () => {
    expect(scopeTableProblems(withScope('| **scope** | treat as clean |')))
      .toContain('scope\'s when it cannot be confirmed value is "treat as clean", expected one of did not run');
  });

  // tkt-32f7c384bcad findings 4-6, each measured CLEAN against the first cut. One omission across a
  // dimension: the adversary list sampled the value cell and never the NAME cell.
  it('flags an exemption bolted onto the check NAME, which levelLabel used to strip', () => {
    expect(scopeTableProblems(withScope('| **scope** (skip in foreign mode) | did not run |')))
      .toContain('post-review checks with no row: scope');
  });

  it('flags qualifiers the skip-word denylist never knew', () => {
    expect(scopeTableProblems(withScope('| **scope** | did not run (unless the diff is docs-only) |')))
      .toContain('scope\'s when it cannot be confirmed value is "did not run (unless the diff is docs-only)", expected one of did not run');
    expect(scopeTableProblems(withScope('| **scope** | did not run — except in foreign mode |')))
      .toContain('scope\'s when it cannot be confirmed value is "did not run — except in foreign mode", expected one of did not run');
  });

  it('reports a FENCED example table as no table, rather than as the real one', () => {
    // With the real table deleted, a fenced EXAMPLE measured CLEAN.
    expect(scopeTableProblems(doc('```markdown', ...ROWS, '```')))
      .toContain('no post-review table found under a "review" heading');
  });

  it('reports a missing table rather than returning clean', () => {
    expect(scopeTableProblems('# nothing here')).toContain('no post-review table found under a "review" heading');
  });

  it('refuses to guess when two headings match "review"', () => {
    const md = '## 3. Review notes\n\n| a | b |\n|---|---|\n| x | y |\n\n' + doc(...ROWS);
    expect(scopeTableProblems(md))
      .toContain('2 headings match "review" — cannot tell which table is the post-review table');
  });
});

describe('the startup/handoff checker itself', () => {
  const skillWith = (...handoff) => [
    '## 15. Close the ticket — wrap-up check, then the handoff',
    '',
    '### The handoff',
    '',
    ...handoff,
    '',
    gateDoc(HEADER, ...GOOD),
  ].join('\n');
  const skill = (invocation = '/kanban-workflow <project> --gates manual') => skillWith('```', invocation, '```');
  const claude = (...body) => ['# Kanban Project', '', '## Session startup (MANDATORY)', '', ...body, '', '## MCP server'].join('\n');
  const START = ['```', '/kanban-workflow <project> --gates manual', '```'];

  it('passes a matching pair — so the flags below are not fired by everything', () => {
    expect(startupPromptProblems(claude(...START), skill())).toEqual([]);
  });

  it('flags a startup prompt pre-filling an auto level', () => {
    expect(startupPromptProblems(claude('```', '/kanban-workflow <project> --gates auto-pr', '```'), skill()))
      .toContain('startup recommends `--gates auto-pr` but the handoff prints `--gates manual`');
  });

  it('flags BOTH ends drifting together, which comparing them to each other alone misses', () => {
    // Agreement is not sufficient: an auto level pre-filled in BOTH files agrees perfectly and
    // re-grants an authorization nobody gave. Hence checking the level against the table.
    const md = claude('```', '/kanban-workflow <project> --gates auto-pr', '```');
    expect(startupPromptProblems(md, skill('/kanban-workflow <project> --gates auto-pr')))
      .toContain('the startup recommendation pre-fills `--gates auto-pr`, which does not ask at every gate; `manual` does');
  });

  // The two fail-opens that survived all 60 tests of the first cut, both on the SKILL.md side — its
  // fixtures mutated only the CLAUDE.md end. One omission across a dimension, not two cases.
  it('reports a DELETED handoff invocation rather than returning clean', () => {
    expect(startupPromptProblems(claude(...START), skillWith('Print something helpful, then stop.')))
      .toContain('no slash-command invocation in SKILL.md\'s "The handoff" subsection');
  });

  it('flags a handoff pre-filling an auto level', () => {
    expect(startupPromptProblems(claude(...START), skill('/kanban-workflow <project> --gates auto-pr')))
      .toContain('the close handoff pre-fills `--gates auto-pr`, which does not ask at every gate; `manual` does');
  });

  it('reports a DELETED startup invocation rather than returning clean', () => {
    expect(startupPromptProblems(claude('Just load the board and ask which ticket to start.'), skill()))
      .toContain('no slash-command invocation in CLAUDE.md\'s "Session startup" section');
  });

  it('refuses to guess between two invocations in one section', () => {
    const bad = skillWith('```', '/kanban-workflow <project> --gates manual', '/kanban-workflow <project> --gates auto-pr', '```');
    expect(startupPromptProblems(claude(...START), bad))
      .toContain('2 slash-command invocations in SKILL.md\'s "The handoff" subsection — expected 1');
  });

  it('flags an invocation carrying no --gates at all', () => {
    // The `passes no --gates level` push is the ONLY thing between a level-less pair and a clean
    // report — the next line returns early on it. Deleting the loop left 34/34 green.
    expect(startupPromptProblems(claude('```', '/kanban-workflow <project>', '```'), skill()))
      .toContain('the startup recommendation passes no `--gates` level');
    expect(startupPromptProblems(claude(...START), skill('/kanban-workflow <project>')))
      .toContain('the close handoff passes no `--gates` level');
  });

  it('flags the two files naming DIFFERENT skills', () => {
    expect(startupPromptProblems(claude('```', '/kanban-cycle <project> --gates manual', '```'), skill()))
      .toContain('startup recommends `/kanban-cycle` but the handoff prints `/kanban-workflow`');
  });

  it('refuses to guess when two sections match the handoff', () => {
    // sliceSection's ambiguity guard: §15 already carries three subsections, so a second one naming
    // the handoff is a plausible edit. Resolving it by position binds to the wrong one silently.
    const bad = skill().replace('### The handoff', '### The handoff\n\nplaceholder\n\n### The handoff, continued');
    expect(startupPromptProblems(claude(...START), bad))
      .toContain('2 headings match SKILL.md\'s "The handoff" subsection — cannot tell which section carries the invocation');
  });
});

describe('the startup ticket-slot checker itself', () => {
  const claude = (...body) => ['# Kanban Project', '', '## Session startup (MANDATORY)', '', ...body, '', '## MCP server'].join('\n');

  it('passes a slot-free startup — so the flags below are not fired by everything', () => {
    expect(startupTicketSlotProblems(claude('```', '/kanban-workflow <project> --gates manual', '```'))).toEqual([]);
  });

  it('flags a VALID id bolted onto the startup line', () => {
    // The case that makes this binding worth keeping: a valid id passes §5, so §0 skips §4's ranking
    // and every session from this prompt works a ticket nobody chose.
    expect(startupTicketSlotProblems(claude('```', '/kanban-workflow kanban --gates manual tkt-0123456789ab', '```')))
      .toEqual(['the startup recommendation carries a ticket slot, but a cold session has no ranking to carry']);
  });

  it('flags a placeholder slot too, not only a substituted id', () => {
    expect(startupTicketSlotProblems(claude('```', '/kanban-workflow <project> --gates manual <next ticket id>', '```')))
      .not.toEqual([]);
  });

  it('reports a MISSING startup section rather than returning clean', () => {
    expect(startupTicketSlotProblems(['# Kanban Project', '', '## MCP server', '', 'nothing'].join('\n')))
      .toEqual(['no section found for CLAUDE.md\'s "Session startup" section']);
  });
});
