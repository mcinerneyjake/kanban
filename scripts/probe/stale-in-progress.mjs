#!/usr/bin/env node
// Audit `in-progress` tickets for whether their status is ACCOUNTED FOR.
//
// Paid for by a 2026-08-28 audit that called 3 of 9 in-progress tickets "parked" and was wrong on
// every one (tkt-3f2ba36ec57f's session). That audit measured branches, commits and pipeline logs —
// the right instrument for code tickets and the wrong one for a ticket whose deliverable is a human
// picking dropdown values, an offline Windows PC, an EIN application or a Postmark account. It read
// "no branch" as "no work". The same false flag had already been raised and retracted once before,
// inside tkt-639be86eb24d's own body.
//
// So this probe reads what the BOARD knows — blockers, and the ticket's own prose — and never git.
//
// THE LOAD-BEARING DESIGN RULE: for any ticket it cannot account for, it prints the tail of that
// ticket's body instead of a verdict. The phrase list below is necessarily incomplete (these bodies
// are freeform, and greps over them have measured false negatives in both directions), so a human
// reading the actual words is the check on this instrument — not the instrument itself.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 7);

// Phrases that record a DELIBERATE decision to hold `in-progress`. Drawn from real bodies on this
// board. Deliberately NOT exhaustive and cannot be: a miss here yields UNACCOUNTED, which prints the
// body tail for a human — the safe direction. A false POSITIVE would silence a real orphan, so keep
// these specific and never add a bare word like "progress".
const INTENT = [
  /\bstays?\s+`?in-progress`?/i,
  /\bremains?\s+`?in-progress`?/i,
  /\b(deliberately|explicitly)\s+(left|kept)\s+`?in-progress`?/i,
  /\bstatus\s+(deliberately\s+)?(left\s+)?unchanged\b/i,
  /\bgenuinely\s+mid-flight\b/i,
  /\bnot\s+(parked|abandoned)\b/i,
  /\bawaiting\s+the\s+human\b/i,
  /\bhuman-only\b/i,
  /\bPAUSED\b/,
  /\bsession\s+parked\s+here\b/i,
  /\bblocked\s+on\b/i,
  /\bresume\s+here\b/i,
];

const OPEN = new Set(['backlog', 'todo', 'in-progress', 'qa']);

// Strip fenced code blocks: a body quoting one of these phrases inside a fence is documentation of
// the marker, not a use of it. Same contamination path adoption-markers.mjs guards against.
function stripFences(body) {
  return body.replace(/^```[\s\S]*?^```/gm, '');
}

// Minimal frontmatter reader for the shapes these files actually use: `key: value` and a block list
// (`blockers:` followed by `  - id`). Returns null when there is no frontmatter at all, which the
// caller treats as UNREADABLE rather than as an empty ticket.
export function parseTicket(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body = ''] = m;
  const out = { blockers: [], body };
  let listKey = null;
  for (const line of fm.split('\n')) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (listKey && item) {
      out[listKey].push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    listKey = null;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (val === '' ) { listKey = key; out[key] = out[key] ?? []; continue; }
    if (val === '[]') { out[key] = []; continue; }
    out[key] = val.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function hasIntent(body) {
  const clean = stripFences(body);
  return INTENT.some((re) => re.test(clean));
}

// Classify one in-progress ticket. `statusOf` resolves another ticket id to its status, or
// undefined when that ticket does not exist (link rot — a finding, never a free pass).
export function classify(t, statusOf, now) {
  const reasons = [];
  let openBlockers = [];
  let rottenBlockers = [];
  for (const b of t.blockers ?? []) {
    const s = statusOf(b);
    if (s === undefined) rottenBlockers.push(b);
    else if (OPEN.has(s)) openBlockers.push(`${b}(${s})`);
  }
  if (openBlockers.length) reasons.push(`BLOCKED by ${openBlockers.join(', ')}`);
  if (hasIntent(t.body)) reasons.push('DECLARED in body');

  const updated = Date.parse(t.updated ?? '');
  const ageDays = Number.isNaN(updated) ? null : Math.floor((now - updated) / 86400000);
  if (ageDays !== null && ageDays <= WINDOW_DAYS) reasons.push(`TOUCHED ${ageDays}d ago`);

  return {
    tier: reasons.length ? 'accounted' : 'unaccounted',
    reasons,
    ageDays,
    rottenBlockers,
  };
}

// A probe that cannot fail is not a probe. Each control is a shape this classifier MUST get right;
// a miss throws instead of emitting a count, so a broken instrument can never print a clean board.
function assertInstruments() {
  const now = Date.parse('2026-08-28T00:00:00Z');
  const old = "updated: '2026-01-01T00:00:00Z'";
  const fresh = "updated: '2026-08-27T00:00:00Z'";
  const mk = (upd, body, blockers = '') =>
    parseTicket(`---\nid: tkt-000000000001\nstatus: in-progress\n${upd}\n${blockers}---\n${body}\n`);
  const none = () => 'done';

  const cases = [
    // [name, ticket, statusOf, expected tier, must-appear reason fragment]
    ['stale + silent => the finding', mk(old, 'Nothing here.'), none, 'unaccounted', null],
    ['declared intent', mk(old, 'Status stays `in-progress` — awaiting hardware.'), none, 'accounted', 'DECLARED'],
    ['recently touched', mk(fresh, 'Nothing here.'), none, 'accounted', 'TOUCHED'],
    [
      'open blocker',
      mk(old, 'Nothing here.', 'blockers:\n  - tkt-000000000002\n'),
      () => 'todo',
      'accounted',
      'BLOCKED',
    ],
    [
      'CLOSED blocker must NOT excuse it',
      mk(old, 'Nothing here.', 'blockers:\n  - tkt-000000000002\n'),
      () => 'done',
      'unaccounted',
      null,
    ],
    // The exact contamination adoption-markers.mjs was built to reject: a body QUOTING the marker
    // inside a fence is paperwork, not a decision.
    ['fenced marker does not count', mk(old, '```\nStatus stays `in-progress`\n```'), none, 'unaccounted', null],
  ];

  for (const [name, t, statusOf, wantTier, wantReason] of cases) {
    if (!t) throw new Error(`instrument: control "${name}" failed to parse at all`);
    const got = classify(t, statusOf, now);
    if (got.tier !== wantTier)
      throw new Error(`instrument: control "${name}" => ${got.tier} (${got.reasons.join('; ') || 'no reasons'}), want ${wantTier}`);
    if (wantReason && !got.reasons.some((r) => r.includes(wantReason)))
      throw new Error(`instrument: control "${name}" missing reason ${wantReason}: ${got.reasons.join('; ')}`);
  }

  // Blocker link-rot must surface, not read as blocked.
  const rot = classify(
    mk(old, 'Nothing here.', 'blockers:\n  - tkt-ffffffffffff\n'),
    () => undefined,
    now,
  );
  if (!rot.rottenBlockers.length) throw new Error('instrument: link-rot control did not report a rotten blocker');
  if (rot.tier !== 'unaccounted') throw new Error('instrument: link-rot must not excuse a ticket');
}

function tail(body, n = 12) {
  const lines = stripFences(body).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines.slice(-n);
}

function main() {
  assertInstruments();

  const root = process.argv[2] ?? process.env.BOARD_DIR_OVERRIDE ?? process.cwd();
  const dir = path.resolve(root, 'tickets');
  if (!existsSync(dir)) {
    console.error(`stale-in-progress: no tickets/ directory under ${root} — cannot scan, refusing to report a clean board.`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.error(`stale-in-progress: scanned 0 ticket files under ${dir} — an empty scan is not a clean board.`);
    process.exit(2);
  }

  const all = new Map();
  const unreadable = [];
  for (const f of files) {
    const id = f.replace(/\.md$/, '');
    let t;
    try {
      t = parseTicket(readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      unreadable.push(`${id} (${e.code ?? 'read error'})`);
      continue;
    }
    if (!t || !t.status) { unreadable.push(`${id} (no parseable frontmatter)`); continue; }
    all.set(id, t);
  }

  const statusOf = (id) => all.get(id)?.status;
  const now = Date.now();
  const inProgress = [...all.entries()].filter(([, t]) => t.status === 'in-progress');

  console.log(`board: ${dir}`);
  console.log(`scanned ${files.length} tickets · ${inProgress.length} in-progress · window ${WINDOW_DAYS}d\n`);

  const findings = [];
  const rot = [];
  for (const [id, t] of inProgress.sort((a, b) => (a[1].project ?? '').localeCompare(b[1].project ?? ''))) {
    const c = classify(t, statusOf, now);
    const age = c.ageDays === null ? '?' : `${c.ageDays}d`;
    const label = c.tier === 'accounted' ? 'ok  ' : 'FLAG';
    console.log(`${label} ${id}  ${(t.project ?? '(no project)').padEnd(20)} idle ${age.padStart(4)}  ${c.reasons.join(' · ') || '— no blocker, no stated intent, not recently touched'}`);
    if (c.rottenBlockers.length) rot.push([id, c.rottenBlockers]);
    if (c.tier !== 'accounted') findings.push([id, t]);
  }

  if (rot.length) {
    console.log('\n--- blocker link-rot (named ticket does not exist) ---');
    for (const [id, bs] of rot) console.log(`  ${id} -> ${bs.join(', ')}`);
  }

  if (findings.length) {
    console.log(`\n--- ${findings.length} unaccounted. Their own words follow. READ THESE, do not act on the flag. ---`);
    console.log('The phrase list in this probe is incomplete by construction; a ticket flagged here may');
    console.log('still be legitimately in-progress for a reason nobody wrote in a form a regex can see.\n');
    for (const [id, t] of findings) {
      console.log(`### ${id} — ${t.title ?? '(untitled)'}`);
      for (const l of tail(t.body)) console.log(`    ${l}`);
      console.log('');
    }
  }

  if (unreadable.length) {
    console.log('--- UNREADABLE (absent from every count above) ---');
    for (const u of unreadable) console.log(`  ${u}`);
  }

  const bad = findings.length + unreadable.length + rot.length;
  console.log(bad === 0
    ? `\nAll ${inProgress.length} in-progress tickets are accounted for.`
    : `\n${findings.length} unaccounted · ${rot.length} link-rot · ${unreadable.length} unreadable.`);
  process.exit(bad === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
