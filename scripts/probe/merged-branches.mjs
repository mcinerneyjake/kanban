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

// An inherited git context overrides `cwd`, so the probe would read branches from a
// DIFFERENT repo than the one it names — and emit a `branch -D` aimed at this one.
// Git exports an absolute GIT_DIR into every hook environment (tkt-cf1e0c0b3dda), so
// this is reachable from any hook or wrapper. Same scrub as `repo-stats.mjs`.
const GIT_CONTEXT_VARS = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
];

export function scrubbedEnv(base = process.env) {
  const env = { ...base };
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  return env;
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (e) {
    throw new ProbeError(`git ${args.join(' ')} failed in ${cwd}: ${String(e?.stderr || e?.message || e).trim()}`, {
      cause: e,
    });
  }
}

// %(worktreepath) is non-empty when a branch is checked out somewhere: `git branch -D`
// refuses those, and refuses them AFTER deleting the rest, so a mixed list half-applies
// and exits 1. Carrying it here costs nothing.
export function listLocalBranches(cwd) {
  const out = git(
    ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(worktreepath)', 'refs/heads'],
    cwd,
  );
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [name, tip, worktree] = line.split('\t');
    return { name, tip, worktree: worktree || null };
  });
}

/**
 * Resolve the default branch from the REMOTE. A local branch merely being named `main`
 * proves nothing: on a repo whose real default is `develop`, trusting a stale local
 * `main` makes `develop` an ordinary judged branch and can put it in the delete list —
 * the exact outcome this function refuses to risk, so it never guesses from local refs.
 */
export function resolveDefaultBranch(cwd) {
  try {
    const ref = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name) return name;
  } catch {
    // origin/HEAD is often unset on a local clone; fall through to the remote-ref probe.
  }
  const remote = ['main', 'master'].filter((candidate) => {
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], cwd);
      return true;
    } catch {
      return false;
    }
  });
  if (remote.length === 1) return remote[0];

  throw new ProbeError(
    `Could not resolve the default branch in ${cwd}: origin/HEAD is unset and ` +
      (remote.length
        ? `both origin/main and origin/master exist, so which one is default is ambiguous. `
        : `neither origin/main nor origin/master exists. `) +
      `Refusing to guess — guessing wrong puts the real default branch in the delete list. ` +
      `Fix with: git remote set-head origin --auto`,
  );
}

/**
 * Merged PRs as name -> Set of head commit oids. A full page is treated as
 * truncated, since a truncated list silently makes merged branches look unmerged.
 */
const ghMergedPrs = (cwd, limit) =>
  execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(limit),
      '--json',
      'number,headRefName,headRefOid,baseRefName',
    ],
    { cwd, encoding: 'utf8', env: scrubbedEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );

// `fetch` is injectable so the truncation and malformed-output paths can be driven in
// tests; a stubbed-gh test drives the whole chain, and the shape gh returns is pinned
// by `baseRefName` being required below.
export function listMergedPrs(cwd, limit = DEFAULT_LIMIT, fetch = ghMergedPrs, baseRef = null) {
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
  // Every other malformed-gh case raises a ProbeError; a non-array would otherwise
  // escape as a bare TypeError from the loop below.
  if (!Array.isArray(prs)) {
    throw new ProbeError(`gh returned ${typeof prs}, not an array of PRs, in ${cwd}: ${raw.slice(0, 200)}`);
  }
  if (prs.length >= limit) {
    throw new ProbeError(
      `gh returned exactly ${prs.length} merged PRs, the requested limit, so the list may be truncated — ` +
        `a truncated list makes merged branches look unmerged. Re-run with --limit ${limit * 2}.`,
    );
  }

  // A PR merged into a FEATURE branch has not landed on the default branch, so its head
  // is not safe to delete. Dropping the base filter made stacked PRs read as landed.
  const offBase = [];
  const byName = new Map();
  for (const pr of prs) {
    if (!pr?.headRefName) continue;
    if (baseRef && pr.baseRefName !== baseRef) {
      offBase.push(`#${pr.number} (into ${pr.baseRefName ?? 'unknown'})`);
      continue;
    }
    const entry = byName.get(pr.headRefName) ?? { oids: new Set(), numbers: [] };
    if (pr.headRefOid) entry.oids.add(pr.headRefOid);
    entry.numbers.push(pr.number);
    byName.set(pr.headRefName, entry);
  }

  // A recorded name with no oid cannot ever match a tip, so it silently becomes a
  // needs-review with a fabricated "tip has moved" reason while the report reads
  // "Safe to delete (0)". That is a field-drift failure, not a clean repo.
  if (byName.size && ![...byName.values()].some((e) => e.oids.size)) {
    throw new ProbeError(
      `gh returned ${byName.size} merged PR(s) but not one head commit oid, so no branch could ever match a ` +
        `tip and every one would be filed as "tip has moved" — a fabricated reason. This is a --json field ` +
        `drift (headRefOid renamed or unsupported by this gh/GHE version), not a clean result.`,
    );
  }
  // `total` is the pre-filter count. The zero-merged refusal below must distinguish "gh
  // returned nothing" (a broken query) from "everything it returned merged elsewhere" (a
  // real, reportable answer) — conflating them blamed the remote for a base filter.
  return { byName, offBase, total: prs.length };
}

/**
 * Pure. `merged` is name -> { oids:Set, numbers:[] }. A branch is safe only when a
 * merged PR carried that name AND its recorded head commit is still the branch tip.
 */
export function classifyBranches({ branches, merged, defaultBranch }) {
  const safe = [];
  const review = [];
  for (const { name, tip, worktree } of branches) {
    if (name === defaultBranch) continue;
    const entry = merged.get(name);
    if (!entry) {
      review.push({ name, tip, reason: 'no merged PR carries this branch name' });
      continue;
    }
    const prs = entry.numbers.map((n) => `#${n}`).join(', ');
    // `git branch -D` refuses a checked-out branch only AFTER deleting the others, so
    // one of these in the safe list makes the paste half-apply and exit 1.
    if (worktree) {
      review.push({ name, tip, prs, reason: `merged as ${prs}, but is checked out at ${worktree}` });
    } else if (entry.oids.has(tip)) {
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

/**
 * POSIX single-quote a shell word. Git's check-ref-format permits `&`, `$`, `(`, `)` and
 * backticks in a branch name, and this output is explicitly labelled paste-me, so an
 * unquoted name can split the command or execute — and a fork PR's head ref is
 * attacker-controlled via `gh pr checkout`.
 */
export function shellQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

export function formatReport(repoPath, { safe, review, defaultBranch, offBase = [] }) {
  const lines = [`${basename(repoPath)} — default branch ${defaultBranch}`];

  lines.push('', `Safe to delete (${safe.length}) — a merged PR carried this exact tip:`);
  if (!safe.length) lines.push('  (none)');
  for (const b of safe) lines.push(`  ${b.name}  — ${b.reason}`);

  lines.push('', `Needs review (${review.length}) — do NOT bulk-delete these:`);
  if (!review.length) lines.push('  (none)');
  for (const b of review) lines.push(`  ${b.name}  — ${b.reason}`);

  if (offBase.length) {
    lines.push(
      '',
      `Ignored ${offBase.length} merged PR(s) whose base was not ${defaultBranch} — their commits are not on the ` +
        `default branch: ${offBase.slice(0, 10).join(', ')}`,
    );
  }

  if (safe.length) {
    lines.push(
      '',
      'Paste to delete the safe set (a human must run this — guard-bash blocks the agent, correctly):',
      `  git -C ${shellQuote(repoPath)} branch -D ${safe.map((b) => shellQuote(b.name)).join(' ')}`,
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
  const { byName: merged, offBase, total } = listMergedPrs(cwd, limit, fetch, defaultBranch);

  // Gated on the PRE-FILTER total, not on `merged.size`: if gh returned PRs and the base
  // filter excluded them all, that is a real answer reported via `offBase`, not a broken
  // query, and blaming the remote for it would be a confidently wrong diagnosis.
  if (!total && branches.length > 1) {
    throw new ProbeError(
      `${top}: gh reported ZERO merged PRs at all while ${branches.length} local branches exist. ` +
        `Every branch would land in needs-review, which reads as "nothing is safe" — but the likelier cause is ` +
        `the wrong remote or an unauthenticated gh. Refusing to report.`,
    );
  }
  return { repoPath: top, offBase, ...classifyBranches({ branches, merged, defaultBranch }) };
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

// Returns an exit code rather than calling process.exit, so stdout can flush.
export function runCli(argv) {
  const args = [...argv];
  let limit = DEFAULT_LIMIT;
  const limitAt = args.findIndex((a) => a === '--limit' || a.startsWith('--limit='));
  if (limitAt !== -1) {
    const inline = args[limitAt].startsWith('--limit=');
    const rawLimit = inline ? args[limitAt].slice('--limit='.length) : args[limitAt + 1];
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`--limit must be a positive integer, got "${rawLimit}"`);
      return EXIT.USAGE;
    }
    limit = n;
    args.splice(limitAt, inline ? 1 : 2);
  }
  const repoPath = args[0];
  if (!repoPath) {
    console.error('usage: merged-branches.mjs <repo-path> [--limit N]');
    return EXIT.USAGE;
  }
  try {
    const result = checkRepo(repoPath, limit);
    // Report the RESOLVED toplevel, never argv: a paste-ready `git -C .` would
    // retarget whichever repo the reader happens to be standing in.
    console.log(formatReport(result.repoPath, result));
    return EXIT.OK;
  } catch (e) {
    console.error(`merged-branches: ${e.message}`);
    return EXIT.PROBE_ERROR;
  }
}

if (isMain()) {
  // NOT process.exit: stdout is async on a pipe and exit() drops pending writes, so a
  // long report piped to a wrapper would be truncated mid-branch-name at exit 0.
  process.exitCode = runCli(process.argv.slice(2));
}
