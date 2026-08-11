#!/usr/bin/env node
/**
 * Classify local branches as safe-to-delete or needs-review (tkt-0993b12650a1).
 *
 * Merged branches pile up because the obvious check is the wrong instrument: a
 * squash-merge makes a branch's commits non-ancestors of the default branch, so
 * `git rev-list --count main..<branch>` reports landed branches as still carrying
 * work. Measured 2026-08-11, that called 11 of kanban's 13 branches live when only
 * 3 were. A merged PR is the ground truth, so this asks GitHub instead of git.
 *
 * Deletion stays a human `git branch -D` — guard-bash blocks the agent, and that
 * is correct. This only produces the list.
 *
 * Every "cannot determine" path throws rather than yielding a short safe-set,
 * because an empty safe-set is indistinguishable from a clean repo:
 *   - `gh` missing, unauthenticated, or the path is not a repo
 *   - the merged-PR page came back exactly full, so it may be truncated
 *   - the default branch cannot be resolved (never guess `main`)
 * A branch whose tip has MOVED since its PR merged is needs-review, not safe:
 * the name matching a merged PR does not mean the commits did.
 */

import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXIT = { OK: 0, USAGE: 2, PROBE_ERROR: 3 };
export const DEFAULT_LIMIT = 500;

class ProbeError extends Error {}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (e) {
    throw new ProbeError(`git ${args.join(' ')} failed in ${cwd}: ${String(e?.stderr || e?.message || e).trim()}`, {
      cause: e,
    });
  }
}

export function listLocalBranches(cwd) {
  const out = git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'], cwd);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [name, tip] = line.split('\t');
    return { name, tip };
  });
}

/** Resolve the default branch from the remote rather than assuming `main`. */
export function resolveDefaultBranch(cwd) {
  try {
    const ref = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name) return name;
  } catch {
    // origin/HEAD is often unset on a local clone; fall through to the probes below.
  }
  for (const candidate of ['main', 'master']) {
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], cwd);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new ProbeError(
    `Could not resolve the default branch in ${cwd} (origin/HEAD unset and neither main nor master exists). ` +
      `Refusing to guess: guessing it wrong puts the real default branch in the delete list.`,
  );
}

/**
 * Merged PRs as name -> Set of head commit oids. A full page is treated as
 * truncated, since a truncated list silently makes merged branches look unmerged.
 */
const ghMergedPrs = (cwd, limit) =>
  execFileSync(
    'gh',
    ['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,headRefName,headRefOid'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );

// `fetch` is injectable so the truncation and malformed-output paths can be driven
// in tests; the CLI test drives the real gh.
export function listMergedPrs(cwd, limit = DEFAULT_LIMIT, fetch = ghMergedPrs) {
  let raw;
  try {
    raw = fetch(cwd, limit);
  } catch (e) {
    throw new ProbeError(
      `Could not list merged PRs in ${cwd}: ${String(e?.stderr || e?.message || e).trim()}. ` +
        `Without them every branch would look unmerged, so this is a failure, not an empty result. ` +
        `Check that gh is installed, authenticated (gh auth status), and that a GitHub remote exists.`,
      { cause: e },
    );
  }

  let prs;
  try {
    prs = JSON.parse(raw);
  } catch (e) {
    throw new ProbeError(`gh returned unparseable JSON in ${cwd}: ${raw.slice(0, 200)}`, { cause: e });
  }
  if (prs.length >= limit) {
    throw new ProbeError(
      `gh returned exactly ${prs.length} merged PRs, the requested limit, so the list may be truncated — ` +
        `a truncated list makes merged branches look unmerged. Re-run with --limit ${limit * 2}.`,
    );
  }

  const byName = new Map();
  for (const pr of prs) {
    if (!pr?.headRefName) continue;
    const entry = byName.get(pr.headRefName) ?? { oids: new Set(), numbers: [] };
    if (pr.headRefOid) entry.oids.add(pr.headRefOid);
    entry.numbers.push(pr.number);
    byName.set(pr.headRefName, entry);
  }
  return byName;
}

/**
 * Pure. `merged` is name -> { oids:Set, numbers:[] }. A branch is safe only when a
 * merged PR carried that name AND its recorded head commit is still the branch tip.
 */
export function classifyBranches({ branches, merged, defaultBranch }) {
  const safe = [];
  const review = [];
  for (const { name, tip } of branches) {
    if (name === defaultBranch) continue;
    const entry = merged.get(name);
    if (!entry) {
      review.push({ name, tip, reason: 'no merged PR carries this branch name' });
      continue;
    }
    const prs = entry.numbers.map((n) => `#${n}`).join(', ');
    if (entry.oids.has(tip)) {
      safe.push({ name, tip, prs, reason: `merged as ${prs}` });
    } else {
      review.push({
        name,
        tip,
        prs,
        reason: `${prs} merged this branch name, but its tip has moved since (local ${tip.slice(0, 7)} is not the merged head)`,
      });
    }
  }
  return { safe, review, defaultBranch };
}

/**
 * Positive and negative controls on the classifier, run before any real repo is
 * read. A broken classifier that returns an empty safe-set looks exactly like a
 * repo with nothing to delete, so this throws rather than reporting a false clean.
 */
export function assertInstruments(classify = classifyBranches) {
  const merged = new Map([
    ['landed', { oids: new Set(['aaa']), numbers: [1] }],
    ['moved', { oids: new Set(['bbb']), numbers: [2] }],
  ]);
  const { safe, review } = classify({
    branches: [
      { name: 'main', tip: 'zzz' },
      { name: 'landed', tip: 'aaa' },
      { name: 'moved', tip: 'ccc' },
      { name: 'never-merged', tip: 'ddd' },
    ],
    merged,
    defaultBranch: 'main',
  });

  const safeNames = safe.map((b) => b.name);
  const reviewNames = review.map((b) => b.name);
  const problems = [];
  // Positive: a merged branch still at its merged head must be found.
  if (!safeNames.includes('landed')) problems.push('a merged, unmoved branch was not reported safe');
  // Negative: nothing else may be.
  if (safeNames.length !== 1) problems.push(`expected exactly 1 safe branch, got ${safeNames.length}`);
  if (!reviewNames.includes('never-merged')) problems.push('an unmerged branch was not held for review');
  if (!reviewNames.includes('moved')) problems.push('a branch that moved after merge was not held for review');
  if (safeNames.includes('main')) problems.push('the default branch was offered for deletion');

  if (problems.length) {
    throw new ProbeError(
      `merged-branches classifier failed its own controls, so its output cannot be trusted: ${problems.join('; ')}`,
    );
  }
}

export function formatReport(repoPath, { safe, review, defaultBranch }) {
  const lines = [`${basename(repoPath)} — default branch ${defaultBranch}`];

  lines.push('', `Safe to delete (${safe.length}) — a merged PR carried this exact tip:`);
  if (!safe.length) lines.push('  (none)');
  for (const b of safe) lines.push(`  ${b.name}  — ${b.reason}`);

  lines.push('', `Needs review (${review.length}) — do NOT bulk-delete these:`);
  if (!review.length) lines.push('  (none)');
  for (const b of review) lines.push(`  ${b.name}  — ${b.reason}`);

  if (safe.length) {
    lines.push(
      '',
      'Paste to delete the safe set (a human must run this — guard-bash blocks the agent, correctly):',
      `  git -C ${repoPath} branch -D ${safe.map((b) => b.name).join(' ')}`,
    );
  }
  return lines.join('\n');
}

export function checkRepo(repoPath, limit = DEFAULT_LIMIT, fetch = ghMergedPrs) {
  assertInstruments();
  const cwd = resolve(repoPath);
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  const defaultBranch = resolveDefaultBranch(cwd);
  const branches = listLocalBranches(cwd);
  const merged = listMergedPrs(cwd, limit, fetch);

  // Both-empty is legitimately clean; merged-empty with branches present means the
  // query worked but matched nothing, which is far more likely a wrong remote than
  // a repo that never merged a PR.
  if (!merged.size && branches.length > 1) {
    throw new ProbeError(
      `${top}: gh reported ZERO merged PRs while ${branches.length} local branches exist. Every branch would ` +
        `land in needs-review, which reads as "nothing is safe" — but the likelier cause is the wrong remote ` +
        `or an unauthenticated gh. Refusing to report.`,
    );
  }
  return { repoPath: top, ...classifyBranches({ branches, merged, defaultBranch }) };
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Node realpaths the entry module, so a symlinked invocation would otherwise make
// this whole CLI a silent exit-0 no-op.
function isMain() {
  const argv1 = process.argv[1];
  return Boolean(argv1) && real(argv1) === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const args = process.argv.slice(2);
  const limitAt = args.indexOf('--limit');
  let limit = DEFAULT_LIMIT;
  if (limitAt !== -1) {
    const n = Number(args[limitAt + 1]);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`--limit must be a positive integer, got "${args[limitAt + 1]}"`);
      process.exit(EXIT.USAGE);
    }
    limit = n;
    args.splice(limitAt, 2);
  }
  const repoPath = args[0];
  if (!repoPath) {
    console.error('usage: merged-branches.mjs <repo-path> [--limit N]');
    process.exit(EXIT.USAGE);
  }
  try {
    const result = checkRepo(repoPath, limit);
    // Report the RESOLVED toplevel, never argv: a paste-ready `git -C .` would
    // retarget whichever repo the reader happens to be standing in.
    console.log(formatReport(result.repoPath, result));
    process.exit(EXIT.OK);
  } catch (e) {
    console.error(`merged-branches: ${e.message}`);
    process.exit(EXIT.PROBE_ERROR);
  }
}
