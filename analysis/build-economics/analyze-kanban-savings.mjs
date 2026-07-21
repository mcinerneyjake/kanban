#!/usr/bin/env node
// Build economics: how much did building this repo (app + agent/) + ticket-workflow with Claude
// cost and save vs by hand? Reconstructed from Claude Code session telemetry. Emits an
// AGGREGATES-ONLY snapshot (safe to commit to a public repo — no per-ticket titles, no user paths).
//
// Run (on the machine whose ~/.claude holds the transcripts):  node analyze-kanban-savings.mjs
// Override paths with env: KANBAN_REPO, TW_REPO, OUT.
//
// FOUR MEASUREMENT AUDITS baked in (see README.md):
//   1. Dedup by message.id (max-output record) — streaming logs each response many times (~2.4x overcount).
//   2. Scope to this repo + ticket-workflow — exclude other repos' tickets (the board is central).
//   3. Counterfactual anchored on merged PRs, not ticket counts (tickets are unreliable here).
//   4. Supervision = union wall-clock across concurrent sessions (not per-session sum).
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const KANBAN_REPO = process.env.KANBAN_REPO || resolve(HERE, '..', '..'); // analysis/build-economics/ -> repo root
const TW_REPO = process.env.TW_REPO || resolve(KANBAN_REPO, '..', 'ticket-workflow');
const OUT = process.env.OUT || join(HERE, 'kanban-savings.json');
const HOME = homedir();
// Claude Code encodes a session's cwd into its project-dir name by replacing / and . with -.
const encodeCwd = p => p.replace(/[/.]/g, '-');
const PROJECT_DIRS = [
  join(HOME, '.claude', 'projects', encodeCwd(KANBAN_REPO)),
  join(HOME, '.claude', 'projects', encodeCwd(KANBAN_REPO) + '-agent'),
];

// Per-1M-token USD list pricing. cacheWrite5m = 1.25x input, cacheWrite1h = 2x input, cacheRead = 0.1x input.
// NOTE: assumes standard rates with no >200K "1M-context" premium (per Anthropic docs for Opus 4.x).
const PRICES = {
  'claude-opus-4-8': { in: 5, out: 25 }, 'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 }, 'claude-opus-4-5': { in: 5, out: 25 },
  'claude-fable-5': { in: 10, out: 50 }, 'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
const priceKey = model => {
  if (!model) return null;
  let m = model.replace(/\[1m\]$/, '');
  if (PRICES[m]) return m;
  m = m.replace(/-\d{8}$/, '');
  if (PRICES[m]) return m;
  if (m.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5';
  return null;
};
const costOf = (model, u) => {
  const k = priceKey(model);
  if (!k) return 0;
  const p = PRICES[k];
  return (u.input * p.in + u.output * p.out + u.w5 * p.in * 1.25 + u.w1 * p.in * 2 + u.read * p.in * 0.1) / 1e6;
};

const IDLE_CAP_S = 300;
const PR_HOURS = [2, 3];   // deliberately-low by-hand hours per merged PR (the counterfactual anchor)
const RATE = 100;          // loaded engineer $/hr

const OUT_OF_SCOPE = new Set(['portfolio-site', 'job-networking-tracker']);

function walkJsonl(dir, acc) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, acc);
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
  }
}
const files = [];
for (const d of PROJECT_DIRS) walkJsonl(d, files);
if (!files.length) {
  console.error('No transcripts found under', PROJECT_DIRS, '\nRun this on the machine whose ~/.claude holds the sessions, or set KANBAN_REPO.');
  process.exit(1);
}
const topLevelSet = new Set(files.filter(f => !f.replace(/^.*-(kanban|kanban-agent)\//, '').includes('/')));

// tickets (central board) — for scope filtering only; titles are NEVER written to the snapshot
function readFrontmatter(p) {
  const txt = readFileSync(p, 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const l of m[1].split('\n')) { const mm = l.match(/^(\w+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].replace(/^['"]|['"]$/g, ''); }
  return fm;
}
const tickets = {};
const ticketDir = join(KANBAN_REPO, 'tickets');
if (existsSync(ticketDir)) for (const f of readdirSync(ticketDir)) if (f.endsWith('.md')) { const id = f.replace(/\.md$/, ''); try { tickets[id] = readFrontmatter(join(ticketDir, f)); } catch { /* skip unreadable */ } }
const branchProject = branch => { const m = branch.match(/tkt-[0-9a-f]{12}/); return m ? (tickets[m[0]]?.project ?? null) : null; };

// ---- Phase 1: dedup by message.id, keep the max-output (final) record ----
const records = new Map();
let rawRecords = 0, anon = 0;
for (const f of files) {
  const isTop = topLevelSet.has(f);
  let data; try { data = readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of data.split('\n')) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || !rec.message?.usage) continue;
    rawRecords++;
    const um = rec.message.usage;
    const w1 = um.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5 = um.cache_creation?.ephemeral_5m_input_tokens ?? ((um.cache_creation_input_tokens ?? 0) - w1);
    const cur = {
      input: um.input_tokens || 0, output: um.output_tokens || 0, read: um.cache_read_input_tokens || 0,
      w5: Math.max(0, w5), w1: Math.max(0, w1), model: rec.message.model || 'unknown',
      branch: rec.gitBranch || '(none)', isTop, ts: rec.timestamp ? Date.parse(rec.timestamp) : NaN,
    };
    const id = rec.message.id || ('anon-' + (++anon));
    const prev = records.get(id);
    if (!prev) records.set(id, cur);
    else if (cur.output > prev.output) {
      cur.input = Math.max(cur.input, prev.input); cur.read = Math.max(cur.read, prev.read);
      cur.w5 = Math.max(cur.w5, prev.w5); cur.w1 = Math.max(cur.w1, prev.w1);
      records.set(id, cur);
    }
  }
}

// ---- Phase 2: aggregate unique billed records (scope-filtered) ----
const byModel = {};
const byBranch = {};
const topTs = [];
let topLevelMessages = 0, subagentMessages = 0, firstTs = null, lastTs = null;
const excludedLeak = { cost: 0, count: 0, byProject: {} };
for (const u of records.values()) {
  const cost = costOf(u.model, u);
  const proj = branchProject(u.branch);
  if (proj && OUT_OF_SCOPE.has(proj)) { excludedLeak.cost += cost; excludedLeak.count++; excludedLeak.byProject[proj] = (excludedLeak.byProject[proj] || 0) + cost; continue; }
  const bm = (byModel[u.model] ??= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0, messages: 0 });
  bm.input += u.input; bm.output += u.output; bm.cacheWrite5m += u.w5; bm.cacheWrite1h += u.w1; bm.cacheRead += u.read; bm.cost += cost; bm.messages++;
  const bb = (byBranch[u.branch] ??= { cost: 0, closed: null });
  bb.cost += cost;
  if (u.isTop) topLevelMessages++; else subagentMessages++;
  if (!Number.isNaN(u.ts)) { if (u.isTop) topTs.push(u.ts); if (firstTs === null || u.ts < firstTs) firstTs = u.ts; if (lastTs === null || u.ts > lastTs) lastTs = u.ts; }
}
// union wall-clock supervision (concurrent sessions must not double-count)
topTs.sort((a, b) => a - b);
let activeMs = 0;
for (let i = 1; i < topTs.length; i++) activeMs += Math.min(topTs[i] - topTs[i - 1], IDLE_CAP_S * 1000);
const activeHours = activeMs / 3.6e6;

const totals = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0 };
for (const b of Object.values(byModel)) { for (const k of Object.keys(totals)) totals[k] += b[k]; }
totals.allTokens = totals.input + totals.output + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheRead;

// completed vs unfinished (closed = ship milestone OR ticket status done/archived); only unfinished cost is stripped
const eventsDir = join(KANBAN_REPO, 'events');
const shippedMilestone = new Set();
if (existsSync(eventsDir)) for (const f of readdirSync(eventsDir)) {
  if (!f.startsWith('tkt-') || !f.endsWith('.jsonl')) continue;
  const id = f.replace(/\.jsonl$/, '');
  try { for (const l of readFileSync(join(eventsDir, f), 'utf8').split('\n')) { if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; } if ((r.step === 'commit' && r.state === 'passed') || (r.step === 'done' && r.state === 'reached') || r.step === 'pr_opened') { shippedMilestone.add(id); break; } } } catch { /* skip unreadable */ }
}
const isClosedBranch = branch => { const m = branch.match(/tkt-[0-9a-f]{12}/); if (!m) return true; const id = m[0]; const st = tickets[id]?.status; return shippedMilestone.has(id) || st === 'done' || st === 'archived'; };
let unfinished = { cost: 0, count: 0 };
for (const [branch, b] of Object.entries(byBranch)) if (!isClosedBranch(branch)) { unfinished.cost += b.cost; unfinished.count++; }

// ---- git: LOC + PR counts (publicly reproducible) ----
function repoLoc(repo) {
  if (!existsSync(join(repo, '.git'))) return 0;
  try {
    const list = execSync(`git -C '${repo}' ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.css' '*.scss' '*.html' | grep -Ev 'node_modules|dist/|build/|\\.min\\.' || true`, { encoding: 'utf8', maxBuffer: 1e8 }).split('\n').filter(Boolean);
    let loc = 0; for (const rel of list) { try { loc += readFileSync(join(repo, rel), 'utf8').split('\n').length; } catch { /* skip unreadable */ } }
    return loc;
  } catch { return 0; }
}
const prCount = repo => existsSync(join(repo, '.git')) ? (parseInt(execSync(`git -C '${repo}' log --oneline | grep -Ec '\\(#[0-9]+\\)' || true`, { encoding: 'utf8' }).trim()) || 0) : 0;
const locKanban = repoLoc(KANBAN_REPO), locTw = repoLoc(TW_REPO), totalLoc = locKanban + locTw;
const prKanban = prCount(KANBAN_REPO), prTw = prCount(TW_REPO), totalPRs = prKanban + prTw;

// ---- derived savings (PR-anchored) ----
const claudeCompleted = totals.cost - unfinished.cost;
const days = (firstTs && lastTs) ? (lastTs - firstTs) / 8.64e7 : 0;
const round = n => Math.round(n);
const savings = {
  anchor: { mergedPRs: totalPRs, hoursPerPr: PR_HOURS, ratePerHour: RATE, note: 'deliberately-low; the by-hand side is an estimate, adjust hours/PR to taste' },
  timeSavedHrs: PR_HOURS.map(h => round(totalPRs * h - activeHours)),
  valueUsdSaved: PR_HOURS.map(h => round(totalPRs * h * RATE - claudeCompleted)),
  roi: PR_HOURS.map(h => +((totalPRs * h * RATE) / claudeCompleted).toFixed(1)),
};

const out = {
  asOf: lastTs ? new Date(lastTs).toISOString().slice(0, 10) : null,
  generatedFor: 'kanban repo (app + agent/agentic-rag-demo) + ticket-workflow',
  headline: {
    publiclyVerifiable: { mergedPRs: totalPRs, loc: totalLoc, supervisedHours: +activeHours.toFixed(1), calendarDays: +days.toFixed(1), prsPerDay: +(totalPRs / (days || 1)).toFixed(1) },
    selfReported: { claudeCostUsd: { completedOnly: +claudeCompleted.toFixed(2), allSessions: +totals.cost.toFixed(2) }, tokens: totals.allTokens, billedResponses: records.size },
    estimatedSavings: savings,
  },
  measured: {
    transcriptFiles: files.length, billedResponses: records.size, topLevelMessages, subagentMessages,
    calendarSpan: { first: firstTs ? new Date(firstTs).toISOString() : null, last: lastTs ? new Date(lastTs).toISOString() : null, days: +days.toFixed(1) },
    supervisedHoursUnion: +activeHours.toFixed(1), idleCapSeconds: IDLE_CAP_S,
    totals, byModel,
  },
  dedup: { rawAssistantRecords: rawRecords, uniqueBilledResponses: records.size, method: 'one record per message.id (max-output); streaming partials collapsed' },
  scope: { inScope: 'kanban repo + ticket-workflow (incl. agent/agentic-rag-demo)', excludedProjects: [...OUT_OF_SCOPE], excludedLeak: { cost: +excludedLeak.cost.toFixed(2), responses: excludedLeak.count, byProject: Object.fromEntries(Object.entries(excludedLeak.byProject).map(([k, v]) => [k, +v.toFixed(2)])) }, unattributedNote: '~45% of cost is unattributed main-branch work (planning/board/reviews) — kept as in-repo, not splittable by project' },
  costBasis: { allSessions: +totals.cost.toFixed(2), completedOnly: +claudeCompleted.toFixed(2), unfinished: { cost: +unfinished.cost.toFixed(2), branches: unfinished.count, note: 'branches still open in backlog (no ship milestone and ticket not done/archived)' } },
  counterfactual: { anchor: 'merged PRs (git-verifiable), NOT ticket counts', mergedPRs: totalPRs, prByRepo: { kanban: prKanban, ticketWorkflow: prTw }, loc: { total: totalLoc, kanban: locKanban, ticketWorkflow: locTw } },
  disclosures: [
    'Dollar cost is SELF-REPORTED from private local session transcripts — not independently reproducible. Only mergedPRs / loc / supervisedHours / velocity are publicly verifiable (git).',
    'Claude cost is a FLOOR: CI code-review API usage runs on GitHub Actions, not in local transcripts, and is not counted.',
    'Priced at standard list rates assuming no >200K 1M-context premium.',
    'Tokens are measured; the dollar figure is the assumed cloud-equivalent (list price). The by-hand side is an estimate anchored on PRs x 2-3h.',
  ],
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('Wrote', OUT, '| asOf', out.asOf);
console.log('Verifiable:', totalPRs, 'PRs ·', totalLoc, 'LOC ·', activeHours.toFixed(1), 'supervised hrs ·', out.headline.publiclyVerifiable.prsPerDay, 'PRs/day');
console.log('Self-reported: $' + claudeCompleted.toFixed(2), 'completed-only / $' + totals.cost.toFixed(2), 'all ·', (totals.allTokens / 1e6).toFixed(0) + 'M tokens ·', records.size, 'responses');
console.log('Estimated savings (PRs x 2-3h): time', savings.timeSavedHrs.join('-') + 'h · value $' + savings.valueUsdSaved.join('-$') + ' · ROI ' + savings.roi.join('-') + 'x');
