#!/usr/bin/env node
// PreToolUse(Bash) guardrail — wired in .claude/settings.json.
//
// Blocks git commands that violate the CLAUDE.md "Branch, commit & PR workflow"
// BEFORE they run, instead of relying on the model to remember the rules every
// time:
//
//   1. Whole-tree staging — git add/stage -A | --all | . | * | :/  → forces
//      explicit, per-ticket file staging.
//   2. git commit -a / -am  → also stages the whole working tree, so it's
//      blocked on the same grounds as (1), regardless of branch.
//   3. git commit  while effectively on main → never commit directly to main.
//   4. git push    that targets main, or a bare push while on main → never
//      push to main (explicit non-main targets, deletes, and --tags are fine).
//
// SCOPE: this is a best-effort guard against the assistant's own predictable
// commands, NOT an adversarial sandbox. It does NOT defend against deliberately
// obscure forms — e.g. `git --git-dir <path> ...` global-option spoofing, env
// prefixes other than simple VAR=val, or hiding a branch change behind a plain
// `git checkout <branch>` (only `switch` / `checkout -b` are tracked). Defending
// those would mean reimplementing a shell parser; GitHub branch protection is
// the real backstop. See CLAUDE.md → Branch, commit & PR workflow.
//
// Protocol: read the hook payload as JSON on stdin, inspect
// `tool_input.command`. Exit 0 to allow; exit 2 to block (stderr is surfaced to
// Claude so it can self-correct). Anything unexpected → allow (fail open: a
// guardrail must never wedge legitimate work). The decision logic
// (parseGit / decide) is exported and pure so it can be unit-tested without
// spawning a subprocess; the stdin/exit wiring runs only when this file is
// executed directly as the hook entrypoint.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Pull the git subcommand + its args out of a single shell segment. The command
// WORD must be `git` (after stripping leading subshell/group punctuation and
// simple VAR=val env prefixes) — so data that merely mentions git, e.g.
// `echo "git add -A"`, is not treated as a git invocation. Skips global options
// that take a value (`git -C <path> add`, `git -c k=v commit`). Returns null for
// non-git segments.
export function parseGit(segment) {
  const stripped = segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '');
  const tokens = stripped.split(/\s+/);
  let cmd = 0;
  while (cmd < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmd])) cmd++; // env prefix
  if (tokens[cmd] !== 'git') return null;
  let i = cmd + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1; // -C/-c take a value
  }
  if (i >= tokens.length) return null;
  return { sub: tokens[i], args: tokens.slice(i + 1) };
}

// Args that stage the whole working tree rather than named paths.
function stagesEverything(args) {
  const blanket = new Set(['-A', '--all', '.', '*', "'*'", '"*"', ':/', './']);
  return args.some((a) => blanket.has(a));
}

// `git commit -a` / `-am` (a single-dash cluster containing 'a') or `--all`
// stages all tracked files, bypassing the add guard entirely.
function commitStagesAll(args) {
  return args.some(
    (a) => a === '--all' || (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('a')),
  );
}

// True when a push would land on main: an explicit main refspec/target, or a
// bare push while on main (no explicit non-main target and not a delete/tags op).
function pushesMain(args, branch) {
  const positionals = args.filter((a) => !a.startsWith('-'));
  const flags = args.filter((a) => a.startsWith('-'));
  const targetsMain = positionals.some(
    (a) => a === 'main' || a.endsWith(':main') || a.endsWith('/main'),
  );
  if (targetsMain) return true;
  const safeFlag = flags.some((f) => ['--delete', '-d', '--tags', '--prune', '--mirror'].includes(f));
  const explicitTarget = positionals.length >= 2; // remote + refspec → not the current branch implicitly
  return branch === 'main' && !safeFlag && !explicitTarget;
}

// The branch a `switch`/`checkout -b` moves to, so a chain that creates the
// branch first isn't judged against the pre-switch branch. Plain
// `git checkout <x>` is intentionally not tracked (path-vs-branch ambiguous).
function switchTarget(sub, args) {
  if (sub === 'switch' || ((sub === 'checkout') && (args.includes('-b') || args.includes('-B')))) {
    const positionals = args.filter((a) => !a.startsWith('-'));
    return positionals[0] ?? null;
  }
  return null;
}

// Decide whether a (possibly compound) command should be blocked. `getBranch`
// is injected so the logic is pure and testable; it returns the current branch
// name or null when it can't be determined. Returns { blocked, reason }.
export function decide(command, getBranch) {
  if (typeof command !== 'string' || !command.trim()) return { blocked: false };

  // Split on &&, ||, ;, newline so each git invocation is checked independently.
  // Single `|` is intentionally not a split point: piping into the guarded
  // subcommands is not a real workflow, and splitting on it would mangle commit
  // messages that contain a literal `|`.
  const segments = command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let branch = getBranch(); // effective branch, updated as we walk switch/checkout in a chain

  for (const segment of segments) {
    const git = parseGit(segment);
    if (!git) continue;
    const { sub, args } = git;

    if ((sub === 'add' || sub === 'stage') && stagesEverything(args)) {
      return {
        blocked: true,
        reason:
          "git add/stage of the whole tree (-A / --all / . / *) stages everything. Stage only this ticket's files explicitly (git add <path> ...). See CLAUDE.md → Branch, commit & PR workflow.",
      };
    }

    if (sub === 'commit' && commitStagesAll(args)) {
      return {
        blocked: true,
        reason:
          "git commit -a / -am stages every tracked change, bypassing per-ticket staging. Stage this ticket's files explicitly, then commit without -a. See CLAUDE.md.",
      };
    }

    if (sub === 'commit' && branch === 'main') {
      return {
        blocked: true,
        reason:
          'Direct commits to main are not allowed — every ticket lands on its own branch via a squash-merged PR. Cut a <type>/<id>-<slug> branch first. See CLAUDE.md.',
      };
    }

    if (sub === 'push' && pushesMain(args, branch)) {
      return {
        blocked: true,
        reason:
          'Direct pushes to main are not allowed — push your ticket branch and open a PR. See CLAUDE.md → Branch, commit & PR workflow.',
      };
    }

    const moved = switchTarget(sub, args);
    if (moved) branch = moved;
  }

  return { blocked: false };
}

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // detached / not a repo → can't assert branch, so don't block
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not our concern if we can't parse the event
  }

  const { blocked, reason } = decide(payload?.tool_input?.command, currentBranch);
  if (blocked) {
    process.stderr.write(`[guard-bash] Blocked: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Run the I/O wiring only when invoked directly as the hook (not when imported
// by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
