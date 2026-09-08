#!/usr/bin/env node
/**
 * Which of a repo's gate scripts does its pre-commit hook ACTUALLY run (tkt-ea501e6d1a1d).
 *
 * The night run pays for the quality gate twice: once when the session runs
 * `typecheck`/`lint`/`test` itself, and again inside the commit's pre-commit hook. Skipping
 * the session's pass is only safe where the hook demonstrably runs the same commands, and
 * measured 2026-09-08 that is 4 of the 9 repos in `repos.local.json` — `equipment-schedule`'s
 * hook runs an unrelated script and four repos have no pre-commit hook at all. An
 * unconditional skip would delete the gate outright in five repos.
 *
 * So coverage is claimed only on POSITIVE evidence. Every uncertain path yields fewer covered
 * scripts (the session runs more), and the genuinely undeterminable paths throw:
 *   - `core.hooksPath` names a directory that cannot be read
 *   - a hook file exists but cannot be read
 *   - the path is not a git repo
 * There is deliberately no path where not knowing means skipping.
 *
 * Traps this encodes, each measured while building it:
 *   - `core.hooksPath` may be UNSET, relative, or ABSOLUTE, and all three are live in this fleet —
 *     read it with `git config --show-origin --show-scope --get-all core.hooksPath` rather than
 *     believing either form, since `git config --get` alone from the wrong cwd answers about another
 *     repo. Joining an absolute hooksPath onto the repo path yields a nonsense path, which reported a
 *     repo whose hook is a full gate as having no hook — the fail-open direction.
 *   - husky wires `core.hooksPath` at `.husky/_`, whose shim ends `[ ! -f "$s" ] && exit 0`.
 *     A wired hooksPath with no user script under `.husky/` therefore runs NOTHING, silently.
 *   - `HUSKY=0` in the environment disables every husky hook, and git skips a hook that is not
 *     executable. Both mean the file's contents are irrelevant.
 *   - `npm run test:e2e` is not `test`, and `npm run lint:fix` is not `lint`. A `\btest\b` match
 *     counts both, which is how a hook that runs neither reads as covering both.
 *   - Every hook in this fleet opens with a comment block naming scripts in prose, so comments
 *     are stripped before matching.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, accessSync, existsSync, realpathSync, constants } from 'node:fs';
import { resolve, join, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { OK: 0, USAGE: 2, PROBE_ERROR: 3 };

/** The gate SKILL.md section 9 derives: whichever of these the target's package.json defines. */
export const GATE_SCRIPTS = ['typecheck', 'lint', 'test'];

export class ProbeError extends Error {}

// An inherited git context overrides `cwd`, so the probe would read config from a DIFFERENT
// repo than the one it names — and git exports an absolute GIT_DIR into every hook
// environment (tkt-cf1e0c0b3dda), which is precisely where this probe gets called from. Same
// scrub as `merged-branches.mjs` and `repo-stats.mjs`.
const GIT_CONTEXT_VARS = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  // These override the very value being read: `git -c core.hooksPath=… <cmd>` exports
  // GIT_CONFIG_PARAMETERS to what it runs, and this probe is documented as callable from inside a
  // hook. Scrubbing GIT_DIR while leaving these would remove the wrong half of the inherited context.
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
];

export function scrubbedEnv(base = process.env) {
  const env = { ...base };
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  return env;
}

function git(args, cwd, base = process.env) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: scrubbedEnv(base),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch (e) {
    throw new ProbeError(
      `git ${args.join(' ')} failed in ${cwd}: ${String(e?.stderr || e?.message || e).trim()}`,
      { cause: e },
    );
  }
}

/**
 * `git config --get` exits 1 with EMPTY stderr when the key is simply unset, which is not an
 * error here. Any other failure is, and must not be flattened into "unset": unset sends the
 * lookup to `.git/hooks`, so a swallowed error reports on a hook the repo does not use.
 */
export function readHooksPath(cwd, { exec = execFileSync, base = process.env } = {}) {
  try {
    return (
      exec('git', ['config', '--get', 'core.hooksPath'], {
        cwd,
        encoding: 'utf8',
        env: scrubbedEnv(base),
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() || null
    );
  } catch (e) {
    const stderr = String(e?.stderr ?? '').trim();
    if (e?.status === 1 && !stderr) return null;
    throw new ProbeError(
      `git config --get core.hooksPath failed in ${cwd} (status ${e?.status ?? '?'}): ${stderr || e?.message}. ` +
        `Which hook git would run is undetermined; refusing to report coverage.`,
      { cause: e },
    );
  }
}

/**
 * Strip POSIX shell comments. A `#` only opens a comment at the start of a word, so
 * `${var#prefix}` and `refs/heads#1` survive — the fleet's hooks use the former.
 */
export function stripComments(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

/** Husky's generated shim, which sources `_/h` and runs `../<hook name>` if it exists. */
export function isHuskyShim(text) {
  return /\.\s+"\$\(dirname\s+"\$0"\)\/h"/.test(stripComments(text));
}

function readable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readHook(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    // Present but unreadable is the one case that must not resolve to "runs nothing": that
    // answer is indistinguishable from a repo with no hook, and here it would be a guess.
    throw new ProbeError(
      `${path} exists but could not be read (${e?.code ?? e?.message}), so what the hook runs is ` +
        `undetermined. Refusing to report coverage — fix the permissions and re-run.`,
      { cause: e },
    );
  }
}

/**
 * The script git will actually execute for `pre-commit`, following husky's shim to the user
 * script. Returns `{ path, text }`, or `null` with a `why` when nothing runs.
 *
 * `disabled` cases return null rather than throwing: they are known answers ("the gate does not
 * run here"), and both push work back onto the session, which is the safe direction.
 */
export function resolveHook(repoDir, { env = process.env } = {}) {
  if (String(env.HUSKY ?? '') === '0') {
    return { hook: null, why: 'HUSKY=0 is set in this environment, which disables every husky hook' };
  }

  const hooksPath = readHooksPath(repoDir, { base: env });
  // Relative hooksPath resolves against the working-tree root, per git-config(1); absolute is used
  // verbatim. Joining an absolute path onto repoDir is the measured fail-open, and kanban's IS
  // absolute — `git config --show-origin --show-scope --get-all core.hooksPath` says
  // `local .git/config /…/.husky/_`, while ticket-workflow's and hardpack-site's are `.husky/_`.
  // Re-measure that way rather than trusting either form; both are live in this fleet.
  //
  // With no hooksPath, ask git for the hooks directory instead of assuming `<top>/.git/hooks`:
  // in a worktree or submodule `.git` is a FILE, and reading a path under it yields ENOTDIR, which
  // would be reported as an unreadable hook rather than as no hook.
  const dir = hooksPath
    ? (isAbsolute(hooksPath) ? hooksPath : join(repoDir, hooksPath))
    : resolve(repoDir, git(['rev-parse', '--git-path', 'hooks'], repoDir, env));

  // A configured hooks directory that does not exist is a DETERMINATE answer — git finds no hook and
  // runs nothing (measured: `git hook run pre-commit` in a worktree → "cannot find a hook named
  // pre-commit"). That is the normal state of every worktree, since husky's generated `.husky/_` is
  // self-ignored via `.husky/_/.gitignore` and so is never checked out into one. Only a directory
  // that exists and cannot be read is undetermined.
  if (hooksPath && !existsSync(dir)) {
    return { hook: null, why: `core.hooksPath is ${hooksPath} but ${dir} does not exist, so git runs no hook here` };
  }
  if (hooksPath && !readable(dir)) {
    throw new ProbeError(
      `core.hooksPath is ${hooksPath} but ${dir} exists and cannot be read, so which hook git would ` +
        `run is undetermined. Refusing to report coverage.`,
    );
  }

  const entry = join(dir, 'pre-commit');
  const text = readHook(entry);
  if (text === null) return { hook: null, why: `no pre-commit hook at ${entry}` };
  // Git skips a non-executable hook with a warning, so its contents say nothing about the gate.
  if (!executable(entry)) return { hook: null, why: `${entry} is not executable, so git skips it` };

  if (!isHuskyShim(text)) {
    // A hook sitting in husky's generated `_` directory that this does not recognise is a shim from
    // a husky version whose spelling changed (the range here is `^9.1.7`). Reading it as an ordinary
    // hook would find no npm command and report "covers nothing" — indistinguishable from a repo
    // with a genuinely non-gating hook, so the optimisation would die silently across the fleet.
    if (basename(dir) === '_') {
      throw new ProbeError(
        `${entry} sits in husky's generated directory but is not a shim spelling this probe knows, ` +
          `so the script it delegates to is undetermined. Refusing to report coverage — this probe ` +
          `needs updating for the installed husky.`,
      );
    }
    return { hook: entry, text };
  }

  // Husky's `h` sources `${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh` BEFORE its
  // `[ "${HUSKY-}" = "0" ] && exit 0` check, so an init.sh exporting HUSKY=0 disables every hook
  // while this process's own env says nothing. Absent on this machine as of 2026-09-08; if it
  // appears, what the hook does is no longer readable from the hook.
  const init = join(env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config'), 'husky', 'init.sh');
  if (env.HOME && existsSync(init)) {
    throw new ProbeError(
      `${init} exists and husky sources it before its own HUSKY=0 check, so it can disable every ` +
        `hook without this process seeing it. Coverage is undetermined while that file is present.`,
    );
  }

  // Husky's `h` computes the user script as dirname(dirname($0))/<hook name>; its final
  // `[ ! -f "$s" ] && exit 0` is why a wired hooksPath can run nothing at all.
  const user = join(dirname(dirname(entry)), 'pre-commit');
  const userText = readHook(user);
  if (userText === null) {
    return { hook: null, why: `${entry} is husky's shim but ${user} does not exist, so husky exits 0` };
  }
  return { hook: user, text: userText, via: entry };
}

/** Whichever of GATE_SCRIPTS the target actually defines — the gate SKILL.md section 9 derives. */
export function readGateScripts(repoDir) {
  let raw;
  try {
    raw = readFileSync(join(repoDir, 'package.json'), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw new ProbeError(`${repoDir}/package.json could not be read (${e?.code ?? e?.message})`, { cause: e });
  }
  let scripts;
  try {
    scripts = JSON.parse(raw)?.scripts ?? {};
  } catch (e) {
    throw new ProbeError(`${repoDir}/package.json is not valid JSON, so the gate cannot be derived`, { cause: e });
  }
  return GATE_SCRIPTS.filter((name) => typeof scripts[name] === 'string' && scripts[name].trim());
}

/**
 * Shapes that make "the script is named in this file" stop meaning "the script runs and can fail
 * the commit". Their presence makes coverage UNDETERMINABLE rather than partial, because deciding
 * which branch runs means interpreting the shell:
 *   `npm test || true` / `|| :`     — runs, can never fail the commit
 *   `if [ -n "$CI" ]; then npm test` — does not run locally, which is where the commit happens
 * None of the four covered hooks in this fleet contains any of these (measured 2026-09-08), so this
 * costs nothing today and closes the shape that would silently skip a gate nothing ran.
 */
const NOT_STRAIGHT_LINE = /(^|\s)(if|case|while|until|for|elif)(\s|$)|\|\|\s*(true|:)(\s|$)/;

/**
 * Shell string literals. A script name inside one is prose, not a command — `echo "gate skipped,
 * run npm test yourself"` is the same class as a `#` comment, just quoted, and the comment strip
 * alone does not catch it.
 */
export function stripStrings(text) {
  return String(text).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/**
 * Pure. Which of `gate` the hook body demonstrably invokes, or `null` when the body's shape means
 * that cannot be decided — `null` is the caller's cue to run the whole gate.
 *
 * `(?![\w:.-])` is the load-bearing half of the match: without it `\btest\b` matches
 * `npm run test:e2e` and `\blint\b` matches `npm run lint:fix`, so a hook running neither of the
 * real scripts reports both as covered — the one direction that loses the gate.
 */
export function coveredScripts(hookText, gate = GATE_SCRIPTS) {
  const body = stripStrings(stripComments(hookText ?? ''));
  if (NOT_STRAIGHT_LINE.test(body)) return null;
  return gate.filter((name) => {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b(?:npm|pnpm|yarn)\\s+run\\s+${n}(?![\\w:.-])`).test(body)) return true;
    // npm's built-in shorthands: `npm test` runs the `test` script, `npm run test` aside.
    if (name === 'test' && /\b(?:npm|pnpm|yarn)\s+(?:t|test)(?![\w:.-])/.test(body)) return true;
    return false;
  });
}

/**
 * Positive and negative controls on the pure classifier, run before any repo is read. A broken
 * classifier that returns everything looks exactly like a well-gated repo, and that is the
 * answer that removes the session's gate — so this throws rather than report it.
 */
export function assertInstruments(classify = coveredScripts) {
  const problems = [];
  const eq = (got, want, label) => {
    const g = got === null ? 'null' : got.join(',');
    if (g !== want) problems.push(`${label}: expected [${want}], got [${g}]`);
  };

  // Positive: the real shape, in both spellings the fleet uses.
  eq(classify('npm run typecheck && npm run lint && npm test'), 'typecheck,lint,test', 'full gate');
  // Negative: a comment naming all three must count for nothing.
  eq(classify('# npm run typecheck && npm run lint && npm test\nnode scripts/other.mjs'), '', 'comment-only');
  // Negative: prefixed script names are different scripts.
  eq(classify('npm run test:e2e && npm run lint:fix'), '', 'prefixed names');
  // Negative: a partial hook must report exactly its part, never round up.
  eq(classify('npm run typecheck'), 'typecheck', 'partial gate');
  // Negative: an unrelated hook (equipment-schedule's real shape).
  eq(classify('node scripts/precommit-semicolons.ts'), '', 'unrelated hook');
  // Negative: a name inside a quoted string is prose, like a comment.
  eq(classify('echo "gate skipped — run npm test yourself"'), '', 'quoted mention');
  // Undeterminable: it runs, but can never fail the commit.
  eq(classify('npm run typecheck && npm test || true'), 'null', 'swallowed failure');
  // Undeterminable: whether it runs at all depends on the environment.
  eq(classify('if [ -n "$CI" ]; then npm test; fi'), 'null', 'conditional');

  if (problems.length) {
    throw new ProbeError(
      `hook-gate classifier failed its own controls, so its output cannot be trusted: ${problems.join('; ')}`,
    );
  }
}

export function checkRepo(repoPath, { env = process.env } = {}) {
  assertInstruments();
  const cwd = resolve(repoPath);
  const top = git(['rev-parse', '--show-toplevel'], cwd, env);
  const gate = readGateScripts(top);
  const { hook, text, via, why } = resolveHook(top, { env });
  const found = hook ? coveredScripts(text, gate) : [];
  // `null` means the hook's shape makes coverage undecidable. Returning it as an empty set would be
  // safe by accident today and wrong in principle: the caller could not tell it from a hook that
  // genuinely gates nothing, and the two differ the moment anyone acts on the distinction.
  if (found === null) {
    throw new ProbeError(
      `${hook} runs a gate script conditionally, or in a way that cannot fail the commit, so what it ` +
        `actually gates is undetermined. Refusing to report coverage — run the full gate.`,
    );
  }
  const covered = found;
  return {
    repoPath: top,
    gate,
    hook,
    via: via ?? null,
    why: why ?? null,
    covered,
    remaining: gate.filter((name) => !covered.includes(name)),
  };
}

export function formatReport(r) {
  const list = (a) => (a.length ? a.join(', ') : '(none)');
  const lines = [
    `${r.repoPath}`,
    `  gate scripts in package.json: ${list(r.gate)}`,
    r.hook ? `  pre-commit runs: ${r.hook}${r.via ? ` (via ${r.via})` : ''}` : `  pre-commit: ${r.why}`,
    `  covered by the hook: ${list(r.covered)}`,
    `  the session must still run: ${list(r.remaining)}`,
  ];
  return lines.join('\n');
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Node realpaths the entry module, so a symlinked invocation would otherwise make this CLI a
// silent exit-0 no-op.
function isMain() {
  const argv1 = process.argv[1];
  return Boolean(argv1) && real(argv1) === real(fileURLToPath(import.meta.url));
}

export function runCli(argv, { env = process.env, log = console.log, err = console.error } = {}) {
  const args = argv.filter((a) => a !== '--json');
  const asJson = argv.length !== args.length;
  const repoPath = args[0];
  if (!repoPath || args.length > 1) {
    err('usage: hook-gate.mjs <repo-path> [--json]');
    return EXIT.USAGE;
  }
  try {
    const result = checkRepo(repoPath, { env });
    log(asJson ? JSON.stringify(result, null, 2) : formatReport(result));
    return EXIT.OK;
  } catch (e) {
    // Non-zero rather than an empty coverage report: a caller that reads "covered nothing" runs
    // the full gate and is merely slow, but one that cannot tell the difference between that and
    // a crashed probe will eventually read a crash as an answer.
    err(`hook-gate: ${e.message}`);
    return EXIT.PROBE_ERROR;
  }
}

if (isMain()) {
  // NOT process.exit: stdout is async on a pipe and exit() drops pending writes.
  process.exitCode = runCli(process.argv.slice(2));
}
