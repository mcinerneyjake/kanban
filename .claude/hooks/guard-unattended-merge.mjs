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
// other way — a runner that dies without cleanup leaves the gate set BLOCKED until the file is
// removed. Price that at the BACKGROUND rule, not the merge one: a stale sentinel costs every
// session on this machine its backgrounded Bash calls, not one rare verb (tkt-3b182ba384f3).
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

import { readdirSync } from 'node:fs';
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

// One remedy line per gated action. `message()` defaults to the merge text, so every existing
// caller keeps its current output; `decide()` returns the background one alongside its verdict.
const MERGE_REMEDY =
  'Merging is the one gate that stays human in every mode, and an unattended run cannot ask.';

// All 6 measured night-run halts had used a backgrounded call; 10 of 13 clean runs never did
// (tkt-3b182ba384f3). It is a RACE, not an impossibility, which is why it looks fine most nights.
const BACKGROUND_REMEDY =
  'Re-run it in the foreground with an explicit timeout instead. A backgrounded call ends the turn\n' +
  'with the work still running, and the wake-up that would deliver its result is a race an\n' +
  'unattended run loses.\n' +
  'Shell backgrounding (`&`, `nohup`, `setsid`, `disown`) is refused for the same reason — this\n' +
  'sentence is here because the line above it used to read as a recipe for one (tkt-cba2d225c6e0).';

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

// THE SECOND ROUTE TO A DETACHED TURN, and the one the payload flag cannot see (tkt-cba2d225c6e0).
// `run_in_background` is a flag the tool sets; `cmd &` is something a session TYPES, and it produces
// the identical shape — the call returns at once and the turn ends with the work still running.
// Sharper than an ordinary gap, because the remedy above is what a complying session turns into a
// bypass: told to "re-run it in the foreground", the obvious next keystroke is `&`.
//
// NOT all four named spellings detach on their own, and the code should not imply they do. `&` and
// `setsid` fork by themselves. `nohup cmd` runs in the FOREGROUND — it only suppresses SIGHUP — and
// `disown` acts on an already-backgrounded job; both reach a detached turn only via `&`, which the
// scanner below already catches. They are gated as INTENT markers: in a foreground-only context
// their only purpose is to prepare or preserve a fork, and a false block costs one re-run.
//
// STATED RESIDUALS, filed rather than fixed here, because each needs its own adversary list and a
// guard fix that grows extra repairs is how the guard fix breaks. A wrapper word defeats the keyword
// rule — `time nohup npm test`, `sudo setsid`, `env`, `command`, `nice`, `xargs` all read as the
// wrapper's own command and permit (tkt-44c0d9a5d309). `coproc`, `screen -dm`, `tmux new -d`, `at`
// and `batch` fork with no keyword at all (tkt-f7ae7e9b81a5). A `-c` operand is masked as data though
// it is an execution context, so `bash -c "npm test &"` permits (tkt-b1c953f25b45). And an unbalanced
// `(` inside `$( )` leaks maskInert's depth counter, masking the rest of the command (tkt-9f7fe38a1628).
// All four are why this is an intent signal rather than containment — the `&` scanner is the
// load-bearing half, and the header's SCOPE paragraph applies: a mistake, not a determined agent.
const DETACH_KEYWORDS = new Set(['nohup', 'setsid', 'disown']);

// A wrapper word that is not the command it runs. Stripped for the MERGE scan ONLY: parseGh reads
// the command WORD, so `nohup gh pr merge 12` parsed as `nohup` and the merge rule never ran on it
// (review, HIGH). That is this file's own ordering hazard — night-run.mjs's armed pre-flight accepts
// the SHARED `Blocked:` marker as proof the MERGE gate fired, so a model answering the probe with
// `nohup gh pr merge 999999999` would satisfy the night's single control off the detach rule while
// the merge rule stayed unexercised. The detach rule below must still SEE these words, which is why
// this is a separate strip and not an addition to LEAD_KEYWORDS.
function stripDetachPrefix(segment) {
  let s = segment;
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(s);
    if (!m || !DETACH_KEYWORDS.has(m[1])) return s;
    s = s.slice(m[0].length);
  }
}

const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Quoted spans and `$( … )` substitutions blanked to spaces. LENGTH-PRESERVING, which buys two
// things: an offset into the result still names the same character of the input, so the splitter
// below can slice the ORIGINAL and hand parseGh real quotes; and a blanked span still SEPARATES its
// neighbours, where deleting it would fuse `echo "x" nohup` into one word. This is what makes
// `echo "npm test &"` data rather than a fork — the same reading the merge rule already applies.
function maskInert(segment) {
  let out = '';
  let sq = false;
  let dq = false;
  let subst = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (sq) {
      out += ' ';
      if (c === "'") sq = false;
      continue;
    }
    // An escape, and it failed BOTH ways before this (review, MEDIUM). `\'` opened a masking span
    // that swallowed a real trailing `&` (fail-open), while one `\"` inside a commit message flipped
    // `dq` off and made the message's own `&` read as top-level — refusing an ordinary
    // `git commit -m "handle \" quote & more"` for the whole night (fail-closed, the costlier way).
    // Backslash is literal inside single quotes, hence the `sq` branch above taking precedence.
    if (c === '\\') {
      out += ' ';
      if (i + 1 < segment.length) {
        out += ' ';
        i++;
      }
      continue;
    }
    // A `#` starting a WORD comments out the rest of the segment; mid-word it is an ordinary
    // character (`git log --format=%h#%s`). splitSegments already broke at any newline, so
    // "rest of segment" is "rest of line".
    if (c === '#' && !dq && subst === 0 && (i === 0 || /\s/.test(segment[i - 1]))) {
      out += ' '.repeat(segment.length - i);
      break;
    }
    if (c === "'" && !dq) {
      out += ' ';
      sq = true;
      continue;
    }
    if (c === '"' && subst === 0) {
      out += ' ';
      dq = !dq;
      continue;
    }
    if (c === '$' && segment[i + 1] === '(') {
      out += '  ';
      subst++;
      i++;
      continue;
    }
    if (subst > 0) {
      if (c === '(') subst++;
      else if (c === ')') subst--;
      out += ' ';
      continue;
    }
    out += dq ? ' ' : c;
  }
  return out;
}

/**
 * Split one segment at every top-level `&` that forks or separates, and say whether one was found.
 *
 * ADAPTED, NOT IMPORTED, and it has DIVERGED — do not read the two as interchangeable. Upstream's
 * `hasTopLevelBackground` (`ticket-workflow/hooks/lib/shell.mjs`) is the ancestor, but that subpath
 * is absent from the package's `exports` map — measured `ERR_PACKAGE_PATH_NOT_EXPORTED`, with
 * `guard-bash.mjs` importing cleanly as the control. Three differences, so swapping this for the
 * import later is a behaviour change, not a cleanup: this returns `{parts, backgrounded}` rather
 * than a boolean, it factors the masking out into `maskInert` (upstream inlines it), and it adds the
 * `|&` rule below, which upstream lacks — `npm test |& tee out.log` is permitted here and would be
 * read as a fork upstream. Exporting a reconciled scanner upstream is filed separately.
 *
 * SCANNED, never anchored to the end of the segment: `(npm test &)` and `{ npm test & }` both fork
 * and both end in punctuation. Redirections are why this is not an `indexOf`: `2>&1` and `&>out` are
 * far commoner than forking, and reading either as one would refuse most real commands.
 *
 * Splitting matters beyond the fork itself. `&` also SEPARATES, and `splitSegments` deliberately
 * does not break on it — so `npm test & gh pr merge 12` parsed as the command `npm` and the MERGE
 * rule never ran on it at all.
 *
 * @param {string} segment
 * @returns {{parts: string[], backgrounded: boolean}}
 */
export function splitBackground(segment) {
  const masked = maskInert(segment);
  const parts = [];
  let start = 0;
  let backgrounded = false;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '&') continue;
    if (masked[i + 1] === '&') {
      i++; // `&&` — a separator splitSegments already broke on; never a fork
      continue;
    }
    if (masked[i - 1] === '>' || masked[i - 1] === '<') continue; // `2>&1`, `1<&0` — a redirection
    if (masked[i + 1] === '>') continue; // `&>out`, `&>>out` — a redirection
    if (masked[i - 1] === '|') continue; // `|&` — bash/zsh shorthand for `2>&1 |`, a PIPE not a fork
    backgrounded = true;
    parts.push(segment.slice(start, i));
    start = i + 1;
  }
  parts.push(segment.slice(start));
  return { parts: parts.map((p) => p.trim()).filter(Boolean), backgrounded };
}

// A detach keyword in COMMAND position. Not a substring test, which would refuse `./nohup-report.sh`
// and `cat nohup.out` — both ordinary. Command position is the start of a pipeline stage or group,
// after any env prefix or leading shell keyword, so `echo x | nohup cat` counts and `echo disown`
// does not. Read off the masked view, so a keyword inside quotes is text.
export function detachKeyword(segment) {
  for (const chunk of maskInert(segment).split(/[|;(){}]+/)) {
    const words = chunk.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && (ENV_PREFIX.test(words[i]) || LEAD_KEYWORDS.has(words[i]))) i++;
    if (DETACH_KEYWORDS.has(words[i])) return words[i];
  }
  return null;
}

/**
 * ACTIVE is a DIRECTORY of per-run claim files (tkt-c248cfbc5d8c): any entry is a run, and only an
 * EMPTY directory or a genuine "not there" may permit. The single-owner FILE an older runner writes
 * cannot be listed (ENOTDIR) and so reads as active, which is the direction it should fail.
 *
 * @param {string|null} [sentinel] path to test; null means "could not be determined"
 */
export function nightRunActive(sentinel = SENTINEL) {
  // Cannot locate the primary checkout → cannot rule out a run in flight → active.
  if (!sentinel) return true;
  let entries;
  try {
    entries = readdirSync(sentinel);
  } catch (err) {
    // `existsSync` was the obvious call and is WRONG here: it swallows every error and returns
    // false, so a sentinel under an unreadable directory read as "no run active" and the documented
    // fail-closed guarantee was dead code (review, HIGH — measured: existsSync false, statSync
    // EACCES). Only a genuine "not there" may permit.
    return err?.code !== 'ENOENT';
  }
  return entries.length > 0;
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
 * @returns {{blocked: boolean, reason?: string, remedy?: string}}
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

  // FIRST, and the sub-split on `&` is part of the rule rather than a tidy-up: a merge sitting after
  // a bare `&` is a merge this loop used to miss entirely (see splitBackground).
  for (const raw of splitSegments(command)) {
    for (const part of splitBackground(stripLeadingKeywords(raw)).parts) {
      const segment = stripDetachPrefix(stripLeadingKeywords(part));
      const gh = parseGh(segment);
      if (!gh) continue;
      const reason = /\bapi\b/.test(segment)
        ? apiReason(segment, gh.flags)
        : gh.verb
          ? GATED_GH.get(`${gh.group} ${gh.verb}`)
          : null;
      if (reason) return { blocked: true, reason: `tried to ${reason}` };
    }
  }

  // LAST, and the order is load-bearing (review, MEDIUM). night-run.mjs's armed pre-flight asks a
  // live model to run `gh pr merge 999999999` and accepts the shared `Blocked:` marker as proof the
  // MERGE gate fired. Checked first, a model that backgrounded that probe would satisfy the night's
  // single control via this rule while the merge rule was never reached — a gate reporting confirmed
  // without firing, which this file's header calls the shape it exists to reject.
  //
  // Truthiness, NOT `=== true`: a string 'true' would slip past an equality check, and a foreground
  // call omits the key entirely rather than sending false (measured both ways, tkt-3b182ba384f3).
  if (payload?.tool_input?.run_in_background) {
    return {
      blocked: true,
      reason: 'tried to run a Bash command in the background',
      remedy: BACKGROUND_REMEDY,
    };
  }

  // The same detachment reached by TYPING rather than by setting the flag above, and it inherits the
  // merge rule's ordering for the identical reason: checked earlier, a model that backgrounded the
  // pre-flight's `gh pr merge 999999999` would satisfy the night's single control here while the
  // merge rule was never reached.
  for (const raw of splitSegments(command)) {
    const segment = stripLeadingKeywords(raw);
    const { parts, backgrounded } = splitBackground(segment);
    const keyword = backgrounded ? null : parts.map(detachKeyword).find(Boolean);
    if (backgrounded || keyword) {
      return {
        blocked: true,
        reason: `tried to detach a Bash command from the turn with \`${keyword ?? '&'}\``,
        remedy: BACKGROUND_REMEDY,
      };
    }
  }
  return { blocked: false };
}

export function message(reason, sentinel = SENTINEL, remedy = MERGE_REMEDY) {
  return (
    `[guard-unattended-merge] Blocked: ${reason} while a night run is active.\n` +
    `${remedy}\n` +
    `A run is marked active by a claim under this directory: ${sentinel ?? '(primary checkout could not be located)'}\n` +
    'If no night run is going, a runner exited without cleaning up: `npm run night:status` says who holds a claim, and\n' +
    '`npm run night:stop -- --now` sweeps the claims of runs that are gone. Never remove the directory while a run is live.\n'
  );
}

export { primaryRoot };
