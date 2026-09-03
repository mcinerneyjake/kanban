// PreToolUse(Bash) gate: while a night run is active, no merge-shaped command reaches GitHub
// (tkt-1e6a129c8d7f). Sequenced by the guard-bash launcher, which owns the hook entry.
//
// WHY THIS EXISTS. `guard-bash` inspects git and never gh — measured with a control: 0 matches for
// `gh` against 60 for `git` in the pinned build, and `gh pr merge 12` through the wired launcher
// exits 0. `gh pr merge` lands the commit on main server-side with no `git push`, so the
// never-push-to-main rule is never consulted. Interactively that is fine: a human is at the merge
// gate. Unattended, the gate is prose in a markdown file and nothing else.
//
// SENTINEL, NOT AN ENV VAR. The obvious design is `NIGHT_RUN=1` read from process.env, and it fails
// in the wrong direction: if the variable does not propagate through `claude` into this hook process,
// the guard silently never fires and looks identical to a working one. A sentinel file fails the
// other way — a runner that dies without cleanup leaves merges BLOCKED until the file is removed.
//
// THE SENTINEL LIVES IN THE PRIMARY WORKTREE, AND FINDING IT IS THE WHOLE GAME (review, HIGH).
// The first version resolved it from this module's own path (`../..`). This file is TRACKED, so a
// worktree carries its own copy and `../..` resolved to the WORKTREE root — where the runner never
// wrote a sentinel. That is not a corner case: CLAUDE.md prescribes one worktree per concurrent
// session and SKILL.md:591 runs `ExitWorktree` AFTER the merge, so a native-mode night run merges
// from inside a worktree. Every `gh pr merge` would have been allowed — the exact "guard that
// silently never fires" shape this header claims to reject. `git rev-parse --git-common-dir` points
// at the PRIMARY checkout's .git from any worktree, so its parent is the one stable root.
//
// SCOPE, stated plainly: this stops a MISTAKE, not a determined agent. A session can `rm` the
// sentinel, or `gh alias set m 'pr merge'` and slip past the parser. Neither is in the threat model —
// the risk being managed is an unattended run misreading its instructions, not one deciding to evade
// a guard. Claiming containment this design does not have would be worse than the gap.
//
// COMMIT / PUSH / PR-CREATE STAY ALLOWED. Crossing those is the entire point of `--gates auto-pr`;
// the queue's whole output is open PRs. This gate set is strictly smaller than guard-subagent-gates'.

import { accessSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGh } from 'ticket-workflow/hooks/guard-subagent-gates.mjs';
import { splitSegments } from 'ticket-workflow/hooks/guard-bash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The primary worktree's root, found from this module's directory rather than the process cwd —
// foreign mode `cd`s away, so cwd is not an input. Returns null when git cannot answer, which
// callers treat as "cannot determine" and therefore active.
function primaryRoot(startDir = HERE) {
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: startDir,
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  return dirname(res.stdout.trim()); // <primary>/.git → <primary>
}

const root = primaryRoot();
export const SENTINEL = root ? join(root, '.night-run', 'ACTIVE') : null;

// Only the verbs that LAND work on the default branch. `pr create`, `pr comment` and every read verb
// are absent on purpose — see the header.
const GATED_GH = new Map([['pr merge', 'merge a pull request']]);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// gh sends POST implicitly when any of these is present, so a missing `-X` does NOT mean GET
// (review, MEDIUM): `gh api --input - /repos/o/r/pulls/1/merge` is a merge that read as a GET.
const IMPLICIT_POST = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

// A leading shell keyword hides the command word from the package's segment parser, so
// `if true; then gh pr merge 12; fi` parsed as the command `then` and sailed through (review, LOW).
const LEAD_KEYWORDS = new Set(['then', 'do', 'else', 'elif', '{', '!']);

export function stripLeadingKeywords(segment) {
  let s = segment.trim();
  for (;;) {
    const m = /^([A-Za-z{!]+)\s+/.exec(s);
    if (!m || !LEAD_KEYWORDS.has(m[1])) return s;
    s = s.slice(m[0].length);
  }
}

/**
 * @param {string|null} [sentinel] path to test; null means "could not be determined"
 */
export function nightRunActive(sentinel = SENTINEL) {
  // Cannot locate the primary checkout → cannot rule out a run in flight → active.
  if (!sentinel) return true;
  try {
    accessSync(sentinel);
    return true;
  } catch (err) {
    // `existsSync` was the obvious call and is WRONG here: it swallows every error and returns
    // false, so a sentinel under an unreadable directory read as "no run active" and the documented
    // fail-closed guarantee was dead code (review, HIGH — measured: existsSync false, statSync
    // EACCES). Only a genuine "not there" may permit.
    return err?.code !== 'ENOENT';
  }
}

// `gh api` reaching a merge endpoint is the same action by another route. Matched on the ENDPOINT
// SHAPE rather than by picking positionals out of parseGh: that parser exists to find a command
// group, and reading an API path back out of it was both fragile and wrong — a "first token
// containing a slash" scan matched flag VALUES and falsely blocked `-f head=feat/merge/x` as a merge
// (review, LOW). This pattern cannot match a branch name, because it requires the full
// /repos/<owner>/<repo>/pulls/<n>/merge shape.
const MERGE_ENDPOINT = /\/repos\/[^/\s"']+\/[^/\s"']+\/pulls\/[^/\s"']+\/merge\b/;

function apiReason(segment, flags) {
  const explicit = flags.findIndex((f) => f === '-X' || f === '--method');
  const named =
    (explicit >= 0
      ? flags[explicit + 1]
      : flags.find((f) => f.startsWith('--method='))?.split('=')[1]) ?? null;
  const method = named ?? (flags.some((f) => IMPLICIT_POST.has(f.split('=')[0])) ? 'POST' : 'GET');
  if (!WRITE_METHODS.has(method.toUpperCase())) return null;

  // GraphQL carries no /merge path, and `gh pr merge` is itself a mergePullRequest mutation —
  // feedback_admin_merge records falling back between REST and GraphQL when a merge errors, so an
  // unattended run can reach this by ordinary retry rather than evasion (review, MEDIUM).
  if (/\bgraphql\b/.test(segment)) {
    return /mergePullRequest|mergeBranch/i.test(segment)
      ? 'merge a pull request via the GraphQL API'
      : null;
  }
  return MERGE_ENDPOINT.test(segment)
    ? `merge a pull request via the GitHub API (${method.toUpperCase()})`
    : null;
}

/**
 * @param {unknown} payload the PreToolUse JSON
 * @param {string|null} [sentinel] override for tests
 * @returns {{blocked: boolean, reason?: string}}
 */
export function decide(payload, sentinel = SENTINEL) {
  if (!nightRunActive(sentinel)) return { blocked: false };

  const command = payload?.tool_input?.command;
  // A night run is active and the command cannot be read — the one unknown that would silently
  // disable the rule. Same fail-closed reading guard-subagent-gates uses for its subagent case.
  if (typeof command !== 'string') {
    return {
      blocked: true,
      reason: 'a Bash call with no readable command could not be checked against the merge gate',
    };
  }

  for (const raw of splitSegments(command)) {
    const segment = stripLeadingKeywords(raw);
    const gh = parseGh(segment);
    if (!gh) continue;
    const reason = /\bapi\b/.test(segment)
      ? apiReason(segment, gh.flags)
      : gh.verb
        ? GATED_GH.get(`${gh.group} ${gh.verb}`)
        : null;
    if (reason) return { blocked: true, reason: `tried to ${reason}` };
  }
  return { blocked: false };
}

export function message(reason, sentinel = SENTINEL) {
  return (
    `[guard-unattended-merge] Blocked: ${reason} while a night run is active.\n` +
    'Merging is the one gate that stays human in every mode, and an unattended run cannot ask.\n' +
    `The run is marked active by this file: ${sentinel ?? '(primary checkout could not be located)'}\n` +
    'If no night run is going, the runner exited without cleaning up — remove that file to merge again.\n'
  );
}

export { primaryRoot };
