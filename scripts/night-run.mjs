#!/usr/bin/env node
// Unattended overnight PR queue: one headless session per ticket at `--gates auto-pr`
// (tkt-4f8d07e0810d). Each run halts at the merge gate — human in every mode, and since
// tkt-1e6a129c8d7f *enforced* by guard-unattended-merge — leaving a CI-green PR and the ticket in
// `qa`. Nothing merges.
//
// WHY NODE AND NOT BASH: the classification below is the part with real behaviour, and it is what a
// tired human reads at 8am to decide what to merge. In bash it would be untestable.
//
// WHY CLASSIFY BY STATUS TRANSITION: a `claude -p` result envelope reports `is_error: false` /
// `subtype: success` for an opened PR AND for a hard stop on a failed premise. Exit status cannot
// tell them apart, so the ticket's own status is the only honest signal. Measured 2026-09-02.
//
// WHY A TRANSITION AND NOT AN ABSOLUTE READING: a ticket already in `qa` would score as success
// without the run having done anything.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync, accessSync } from 'node:fs';
import { join } from 'node:path';
import { primaryRoot } from '../.claude/hooks/guard-unattended-merge.mjs';

export const USAGE = 'usage: npm run night -- <ticket-id>...';

// The exit status is the only part of this a cron wrapper or an `|| notify-me` ever reads, so a
// stopping verdict must never share a code with a clean night (review, HIGH).
export const EXIT = { ok: 0, preflight: 1, stopped: 2, alarm: 3, usage: 64 };

// Only a clean, expected transition is an OK. Everything else either stops the queue or is reported
// as needing a human — "can't tell" never returns the permissive answer.
export function classify({ before, after, capped = false }) {
  const verdict = transitionVerdict({ before, after });
  if (!capped) return verdict;
  // A cap must never swallow the alarm: night-report's `isAlarm` is the ONLY thing that rescues a
  // `done` ticket from `isOutstanding`, so returning `capped` here is what makes an unattended merge
  // silent in the morning report — the one silence that hook says is worse than a false alarm.
  if (verdict.level === 'alarm') return verdict;
  // A cap that fires after the ticket reached `qa` has nothing left to interrupt, so dropping the
  // rest of the queue costs a night for nothing (tkt-4fc11782b77b). Gating on the uncapped verdict
  // being `ok`, not on `after === 'qa'`, keeps every transition guard in transitionVerdict binding
  // here too. The wording stays a BOARD reading: nothing here observes that a PR was actually opened.
  if (verdict.level === 'ok') {
    return { level: 'capped-after-qa', stop: false, text: 'hit the wall-clock cap after the ticket reached qa; the queue continues' };
  }
  return { level: 'capped', stop: true, text: 'hit the wall-clock cap; left mid-ticket' };
}

function transitionVerdict({ before, after }) {
  if (!after) {
    return { level: 'note', stop: true, text: `status unreadable after the run (was ${before ?? 'unknown'})` };
  }
  // An unreadable `before` silently collapses this back into the absolute reading the header above
  // says it rejects: with before=null the equality test below is false and a ticket already sitting
  // in `qa` scores a fresh success (review, MEDIUM — measured).
  if (!before) {
    return { level: 'note', stop: true, text: `no status before the run, so no transition can be proven (now ${after})` };
  }
  if (after === before && after !== 'in-progress') {
    return { level: 'note', stop: false, text: `never started (status still ${after})` };
  }
  switch (after) {
    case 'qa':
      return { level: 'ok', stop: false, text: 'PR open, awaiting your merge' };
    case 'done':
      // The guard should have made this impossible. If it happens, something merged unattended and
      // the night must not continue on the assumption that the gate holds.
      return { level: 'alarm', stop: true, text: 'ticket is DONE — the merge gate was crossed; stopping the night' };
    case 'in-progress':
      return { level: 'halt', stop: true, text: 'stopped mid-ticket; needs a human' };
    case 'backlog':
      return { level: 'skip', stop: false, text: 'premise failed; ticket corrected and returned to backlog' };
    default:
      return { level: 'note', stop: true, text: `unexpected status ${after}` };
  }
}

// Anchored on a runner's own summary line and a NON-ZERO count. The first draft scanned the whole
// `--verbose --output-format stream-json` transcript for /\d+ failed/, which matched both
// `Tests 0 failed | 12 passed` and any sentence the model wrote about failures — so nearly every
// halt was labelled UNDIAGNOSED, which is how a genuinely broken branch gets waved past at 8am
// (review, MEDIUM — both measured).
const GATE_SUMMARY = /^\s*(?:Tests|Test Files)\s+[1-9]\d*\s+failed\b/m;
const GATE_NAMED = /^\s*(?:typecheck|lint)\s+failed\b/im;
// Since tkt-ea501e6d1a1d the unattended path may let the pre-commit hook BE the gate, so a failure
// can surface only as husky aborting the commit — tsc/eslint output plus this marker, never the
// session's own "typecheck failed" wording that GATE_NAMED keys on.
const HOOK_REJECTED = /^\s*husky\s+-\s+pre-commit script failed\b/im;

/**
 * `describe` is handed `res.out` — the stdout of `claude -p --output-format stream-json`, one JSON
 * object per line with the session's real output inside string FIELDS, where a newline is the two
 * characters `\n`. Decoding those restores the line starts every anchored pattern here needs.
 *
 * Used by `hookRejected` only, deliberately. Measured 2026-09-08 across all 27 night logs carrying
 * a `summary.json`:
 *
 *   GATE_SUMMARY on the raw log (today's behaviour)  0/27   — it has never once fired
 *   GATE_SUMMARY on the decoded log                  9/27   — but SEVEN of the nine ended `ok`
 *   this husky marker on the decoded log             0/27
 *
 * So decoding `gateFailed` would swap a silent false negative for a false positive on 7 of 9 hits:
 * an intermediate red test run is the NORMAL state of a healthy ticket here, since a red-first repro
 * and the mutation check both require observing red. Which occurrence should count is a real design
 * question and a pre-existing defect, owned by its own ticket — not decided as a rider on this one.
 * husky's marker has no such problem: it is printed only when a hook has actually failed.
 */
export function decodeLog(log) {
  return String(log ?? '').replace(/\\r\\n|\\n|\\r/g, '\n');
}

// Left reading the RAW log, exactly as before this ticket. It is inert on a stream-json log
// (0/27 above) — do not report it as a control that holds.
export function gateFailed(log) {
  const text = log ?? '';
  return GATE_SUMMARY.test(text) || GATE_NAMED.test(text);
}

/**
 * The commit was refused by a pre-commit hook. Deliberately NOT folded into `gateFailed`: husky
 * prints this marker for whatever the hook runs, and across this fleet that is not always the gate
 * — `equipment-schedule`'s hook runs only a semicolon guard, `copart-filter`'s adds `vacuous`.
 * Calling those "the quality gate failed, so this is UNDIAGNOSED, not evidence against the branch"
 * tells the 8am reader to discount a real defect, which is worse than saying nothing.
 */
export function hookRejected(log) {
  return HOOK_REJECTED.test(decodeLog(log));
}

/**
 * The last turn ended with backgrounded tasks still running, so the harness killed them: the session
 * stopped waiting on output that never arrived. Returns their summaries in order, or null when
 * nothing was stranded.
 *
 * Position is the whole predicate, and it is weaker than it looks. A kill ANYWHERE also fires on
 * `tkt-0564cfaeca12`, which opened a PR; requiring it after the FINAL `result` envelope still leaves
 * that log, so `describe` gating on a halt is what makes the claim safe, not this function. Measured
 * over all 27 night logs: 6/6 halts, 1/21 non-halts.
 *
 * Two positions are unknowable rather than negative, and both return null. A log with no envelope at
 * all (`tkt-92360b0e2079`, level `capped`) has nothing to compare against. A log whose final line does
 * not parse was cut mid-write — `run()` merges stderr into the same buffer, and a killed child can
 * stop mid-line — so the closing envelope may be missing, which promotes a mid-session strand to the
 * tail: measured to turn a correct null into a false positive (review, MEDIUM).
 */
export function strandedBackgroundTasks(log) {
  const lines = String(log ?? '').split('\n').filter((line) => line !== '');
  const parse = (line) => {
    if (!line.startsWith('{')) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };
  if (lines.length === 0 || !parse(lines[lines.length - 1])) return null;

  let sawResult = false;
  let stranded = [];
  for (const line of lines) {
    const event = parse(line);
    if (!event) continue;
    // A fresh envelope closes the segment before it, so earlier strands are no longer the tail.
    if (event.type === 'result') {
      sawResult = true;
      stranded = [];
    } else if (event.type === 'system' && event.subtype === 'task_notification' && event.status === 'stopped') {
      stranded.push(String(event.summary ?? ''));
    }
  }
  return sawResult && stranded.length > 0 ? stranded : null;
}

// Summaries are model-authored free text carrying quotes and newlines, and the halt line is a single
// row an 8am reader scans — one embedded newline splits it.
const label = (summary) => {
  const flat = summary.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}\u2026` : flat;
};

export function describe(result, log) {
  if (result.level !== 'halt') return result.text;
  // Checked first so that if `gateFailed` is ever made to fire on a stream-json log, a gate failure
  // inside the hook gets the gate's own wording, which is the more specific of the two. On today's
  // logs it never fires, so a hook-run gate failure reaches the reader through `hookRejected`.
  if (gateFailed(log)) {
    return `${result.text} — the quality gate failed, so this is UNDIAGNOSED, not evidence against the branch`;
  }
  if (hookRejected(log)) {
    return `${result.text} — a pre-commit hook refused the commit, so nothing landed; read the hook's own output before judging the branch`;
  }
  // States only what was DETECTED. An earlier draft added "no gate failed", which asserts the silence
  // of `gateFailed` — a detector this file documents as inert on stream-json (0/27). Measured on
  // `tkt-ab211de0101c`, a halt whose decoded log carries `Tests 1 failed`: that sentence would have
  // told the reader to discount a real failure (review, HIGH).
  const stranded = strandedBackgroundTasks(log);
  if (stranded !== null) {
    const named = stranded.map(label).filter((s) => s !== '');
    const what = stranded.length === 1 ? 'a backgrounded command' : `${stranded.length} backgrounded commands`;
    const quoted = named.length > 0 ? ` (${named.map((s) => `"${s}"`).join(', ')})` : '';
    return `${result.text} — it ended its last turn with ${what} still running${quoted}, which the harness then killed`;
  }
  return result.text;
}

export function readStatus(boardDir, id) {
  try {
    const raw = readFileSync(join(boardDir, 'tickets', `${id}.md`), 'utf8');
    return /^status:\s*(\S+)/m.exec(raw)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function sentinelPaths(root) {
  return { active: join(root, '.night-run', 'ACTIVE'), stop: join(root, '.night-run', 'STOP') };
}

// `existsSync` swallows every error and returns false, so a file under a directory that has become
// unreadable reads as absent. guard-unattended-merge.mjs documents fixing exactly this for ACTIVE;
// the STOP check reused the rejected call (review, LOW/MEDIUM). Only a genuine ENOENT is "absent".
export function fileHere(path) {
  try {
    accessSync(path);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

export function ownerOf(root) {
  try {
    const pid = Number.parseInt(readFileSync(sentinelPaths(root).active, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }
}

// EPERM means the pid exists and belongs to somebody else — still alive, so still holding the gate.
export function pidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Exclusive claim. Two runners sharing one sentinel is not a corner case: the first draft disarmed
 * and re-armed unconditionally, so a second `npm run night` deleted the first one's gate mid-queue
 * and its live sessions could merge (review, HIGH). `wx` makes the claim atomic; a sentinel whose
 * owner is gone is a leak from a crashed run and is taken over, which is also the only thing that
 * stops one crash wedging every later merge.
 */
export function claimSentinel(root, { pid = process.pid, alive = pidAlive } = {}) {
  const { active } = sentinelPaths(root);
  mkdirSync(join(root, '.night-run'), { recursive: true });
  try {
    writeFileSync(active, `${pid}\n`, { flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if (err?.code !== 'EEXIST') return { ok: false, why: `could not claim the sentinel (${err?.code ?? err?.message})` };
  }
  const owner = ownerOf(root);
  // Present but unreadable, or holding a pid we cannot parse: cannot rule out a live run → refuse.
  if (owner === null) {
    return { ok: false, why: `a sentinel already exists at ${active} and its owner could not be read — remove it by hand if no night run is going` };
  }
  if (alive(owner)) {
    return { ok: false, why: `another night run (pid ${owner}) already holds the sentinel at ${active}` };
  }
  rmSync(active, { force: true });
  try {
    writeFileSync(active, `${pid}\n`, { flag: 'wx' });
    return { ok: true, tookOver: owner };
  } catch (err) {
    return { ok: false, why: `could not take over the stale sentinel (${err?.code ?? err?.message})` };
  }
}

export function arm(root, { pid = process.pid } = {}) {
  const { active } = sentinelPaths(root);
  mkdirSync(join(root, '.night-run'), { recursive: true });
  writeFileSync(active, `${pid}\n`);
  return active;
}

// Only ever removes a sentinel this process owns, so a runner that loses a race cannot disarm the
// gate belonging to the run that won it.
export function disarm(root, { pid = process.pid, force = false } = {}) {
  if (!force && ownerOf(root) !== null && ownerOf(root) !== pid) return false;
  rmSync(sentinelPaths(root).active, { force: true });
  return true;
}

export function run(cmd, args, { capMs, graceMs = 10_000, onOutput, input, env } = {}) {
  return new Promise((resolve) => {
    // Undefined `env` inherits, which every other caller here relies on: a bare `{}` would launch
    // `claude` with no PATH.
    const child = spawn(cmd, args, { stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], env });
    let out = '';
    let capped = false;
    let killer = null;
    // SIGTERM is a request. A `claude` holding a hung MCP server would otherwise never close, and the
    // night would hang till morning with the sentinel armed (review, MEDIUM).
    const timer = capMs
      ? setTimeout(() => {
          capped = true;
          child.kill('SIGTERM');
          killer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        }, capMs)
      : null;
    const clear = () => { if (timer) clearTimeout(timer); if (killer) clearTimeout(killer); };
    const take = (b) => { out += b.toString(); onOutput?.(b.toString()); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    // A spawn that fails never emits 'exit', and with no 'error' listener 'close' is lost too — the
    // harness would hang forever.
    child.on('error', (err) => { clear(); resolve({ code: -1, out: String(err), capped }); });
    child.on('close', (code) => { clear(); resolve({ code, out, capped }); });
    if (input != null) {
      child.stdin.on('error', () => {}); // a guard that blocks may exit before draining fd 0
      child.stdin.end(input);
    }
  });
}

// The payload the disarmed half of the pre-flight drives. It must be the SAME command shape the
// armed half is refused, or the pair stops being a control: with no stdin the launcher never reaches
// its merge branch at all, so an empty read exits 0 whatever the gate would have done to a merge.
export const MERGE_PROBE_PAYLOAD = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'gh pr merge 999999999' },
});

const HOOK_MARKER = '[guard-unattended-merge] Blocked:';

/**
 * Did the armed probe actually get refused? A bare /BLOCKED/ substring test passes on its own
 * negation — "The command was not BLOCKED, it RAN." contains the word — and `armed.out` is free-form
 * model prose, so nothing constrains it to the one word we asked for. That put a fail-open in the
 * single check the whole design rests on (review, HIGH). The hook's own marker is authored by the
 * guard rather than the model, so it is the strong signal; otherwise the reply must BE the word.
 */
export function guardBlocked(out) {
  const text = (out ?? '').trim();
  if (text.includes(HOOK_MARKER)) return true;
  if (/\bRAN\b/.test(text)) return false; // ambiguous → refuse; aborting the night is the safe way to be wrong
  const last = text.split('\n').filter((l) => l.trim()).at(-1)?.replace(/[*_`.!]/g, '').trim() ?? '';
  return /^BLOCKED$/i.test(last);
}

export const PROBE_CAP_MS = 180_000;

// THE CONTROL THAT GATES THE NIGHT. Both halves are required: "blocks while armed" alone cannot
// distinguish a working guard from one that blocks unconditionally.
export async function preflightGuard(root, { spawnProbe = run, probeCapMs = PROBE_CAP_MS } = {}) {
  // `gh pr merge 999999999` is gated by shape yet harmless if the guard is broken — it resolves to no
  // such PR and errors. A probe naming a real PR would merge it on exactly the run where the guard
  // has failed, making the control the incident.
  //
  // This half drives a real `claude` session rather than the hook file directly, because what it has
  // to prove is that the hook is WIRED — running the file by hand proves only that its code is right.
  const armed = await spawnProbe('claude', [
    '-p', '--permission-mode', 'auto',
    'Run exactly this one Bash command and reply with only BLOCKED if a hook refused it, or RAN if it executed: gh pr merge 999999999',
  ], { capMs: probeCapMs });
  // The reply is returned on EVERY path below, not just the refusing one. It is the only record of
  // what a live model actually said, and `guardBlocked`'s reading of it is the single control the
  // unattended design rests on — so a passing gate has to be as auditable as a failing one
  // (tkt-a761e990190d). A capped probe keeps whatever it managed to emit.
  const armedOut = armed.out ?? '';
  // `run` resolves a spawn failure as code -1 with the OS error in `out` — not a model reply at all.
  // Unchecked it is stored as one and reported as "the merge guard did not block", which accuses a
  // guard that was never exercised; `claude` off PATH is the likely cause and reads as a broken gate
  // (review, MEDIUM). The session loop below already reads -1 this way.
  if (armed.code === -1) {
    return { ok: false, why: `the armed guard probe could not be started (${armedOut.trim()})`, armedOut };
  }
  // The sentinel is claimed before this await, so a probe that hangs would park the night with every
  // merge blocked and no ticket run (review, MEDIUM).
  if (armed.capped) {
    return { ok: false, why: 'the armed guard probe timed out, so the gate could not be confirmed', armedOut };
  }
  if (!guardBlocked(armedOut)) {
    return { ok: false, why: 'the merge guard did not block while a run was marked active', armedOut };
  }

  disarm(root);
  const hook = join(root, '.claude', 'hooks', 'guard-bash.mjs');
  const off = await spawnProbe(process.execPath, [hook, join(root, '.night-run', 'NOT-THERE')], {
    input: MERGE_PROBE_PAYLOAD,
    capMs: probeCapMs,
  });
  arm(root);
  // The disarmed half's own output is carried too. Its failure message admits it cannot tell "stuck
  // on" from "the launcher failed to load", and `off.out` is the only thing that separates them — a
  // MODULE_NOT_FOUND stack against the guard's own marker. Reporting the ARMED reply on this path
  // shows a clean BLOCKED from the probe that succeeded, pointing the reader at the wrong half
  // (review, MEDIUM).
  const disarmed = { code: off.code, out: off.out ?? '' };
  if (off.capped) {
    return { ok: false, why: 'the disarmed guard probe timed out, so the gate could not be confirmed', armedOut, disarmed };
  }
  // A launcher that cannot load exits 2 as well, so this message names both readings rather than
  // asserting the one it cannot tell apart (review, MEDIUM).
  if (off.code !== 0) {
    return {
      ok: false,
      why: `the merge guard did not permit with no run active (exit ${off.code}) — it is stuck on, or the launcher itself failed to load`,
      armedOut,
      disarmed,
    };
  }
  return { ok: true, armedOut, disarmed };
}

/**
 * The pre-flight's evidence, labelled by WHICH probe spoke. Unlabelled, a disarmed-half failure
 * prints the armed probe's clean `BLOCKED` and reads as though the gate was fine. `(no output)` is
 * written explicitly because a zero-byte record is indistinguishable from a probe that never ran —
 * the exact ambiguity this record exists to remove (review, LOW).
 */
export function renderProbes({ armedOut, disarmed } = {}) {
  const body = (t) => (t?.trim() ? t.trim() : '(no output)');
  let s = `=== armed probe — expected: refused ===\n${body(armedOut)}\n`;
  if (disarmed) {
    s += `\n=== disarmed probe — expected: exit 0 ===\nexit ${disarmed.code}\n${body(disarmed.out)}\n`;
  }
  return s;
}

export function sessionArgs(id) {
  return [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'auto',
    `/kanban-workflow --gates auto-pr ${id}`,
  ];
}

/**
 * What tells a per-ticket session that the night run it can see is its own (tkt-c4743331eb03).
 *
 * From inside the child, a competing session and its own parent are indistinguishable by anything in
 * the repo: `.night-run/ACTIVE` holds a live pid, that pid's argv carries this ticket's id, and
 * `<id>.live.log` — the child's own stdout tee — is growing as it looks. A session that found all
 * three read itself as a competitor and hard-stopped, leaving the ticket `todo` while the queue
 * exited 0. The discriminator cannot be derived from that state, so the runner hands it down.
 *
 * The ticket id, not just a flag: a child working B that stumbles on A's artifacts is looking at a
 * real competitor, and `NIGHT_RUN_TICKET` has to say which.
 */
export function sessionEnv(id, { pid = process.pid, env = process.env } = {}) {
  return { ...env, NIGHT_RUN_TICKET: id, NIGHT_RUN_PID: String(pid) };
}

// The live tee is what `night:status` tails to show a run is still moving; the authoritative record
// stays the `<id>.log` written when the session ends. An append that fails must never take the run
// down with it — losing the tail costs visibility, losing the ticket costs the night.
// `exec` is injected — in the options bag, like every other seam here, so a stray positional argument
// cannot land on it and silently blank `capMs` — because the wiring below is otherwise unreachable
// from a test without spawning `claude`: dropping the `env` line left the whole suite green, which is
// how a per-session id goes missing unnoticed.
export const defaultRunSession = (id, { capMs, logDir, exec = run }) => exec('claude', sessionArgs(id), {
  capMs,
  env: sessionEnv(id),
  onOutput: logDir
    ? (chunk) => { try { appendFileSync(join(logDir, `${id}.live.log`), chunk); } catch { /* observability only */ } }
    : undefined,
});

// `Number(process.env.CAP_SECONDS ?? 2700) * 1000` yields NaN for a typo, and NaN is falsy — so
// `CAP_SECONDS=abc` silently removed the cap altogether (review, MEDIUM). An unreadable value is a
// usage error, never a default.
export function capMsFrom(raw) {
  if (raw === undefined) return { ok: true, capMs: 2700 * 1000 };
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, why: `CAP_SECONDS must be a positive number of seconds, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, capMs: seconds * 1000 };
}

export async function main(
  argv = process.argv.slice(2),
  boardDir = process.cwd(),
  {
    spawnProbe = run,
    runSession = defaultRunSession,
    resolveSentinelRoot = primaryRoot,
    env = process.env,
    exec = run,
    writeProbeLog = writeFileSync,
  } = {},
) {
  const queue = argv.filter((a) => /^tkt-[0-9a-f]{12}$/.test(a));
  if (queue.length === 0 || queue.length !== argv.length) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }

  const cap = capMsFrom(env.CAP_SECONDS);
  if (!cap.ok) {
    process.stderr.write(`${cap.why}\n`);
    return EXIT.usage;
  }

  // The runner must write the sentinel where the GUARD reads it. The guard derives that from its own
  // file via `git rev-parse --git-common-dir`; the first draft used process.cwd(), so running from a
  // worktree armed a sentinel nothing read (review, MEDIUM).
  const root = resolveSentinelRoot();
  if (!root) {
    process.stderr.write('could not locate the primary checkout, so the sentinel the guard reads cannot be written\n');
    return EXIT.preflight;
  }

  const claim = claimSentinel(root);
  if (!claim.ok) {
    process.stderr.write(`pre-flight FAILED: ${claim.why}\nAborting; no tickets were run.\n`);
    return EXIT.preflight;
  }
  if (claim.tookOver) {
    process.stdout.write(`took over a stale sentinel left by pid ${claim.tookOver}\n`);
  }

  const { stop } = sentinelPaths(root);
  // Swept on EVERY exit path, signals and crashes included: `night:stop --now` writes STOP and then
  // signals, so a sweep living only in the finally left it behind (tkt-b90152b23e62).
  const sweepStop = () => {
    try {
      rmSync(stop, { force: true });
    } catch (err) {
      process.stdout.write(`WARNING: the STOP file could NOT be removed (${err?.code ?? err?.message}) — the next run will stop immediately until it is deleted by hand\n`);
    }
  };
  // disarm first — it narrows the check-then-write race with `night:stop` — and the sweep in a finally,
  // since it never throws and a disarm that does must not skip it.
  const cleanup = () => { try { disarm(root); } finally { sweepStop(); } };
  // SIGHUP is the likeliest overnight death of all — an ssh session dropping — and its default action
  // terminates without running the finally, leaking a sentinel that blocks every later merge
  // (review, MEDIUM/HIGH). Listeners are removed again below: a leak per call trips node's
  // max-listeners warning once anything drives main more than ten times.
  const bySignal = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const handlers = Object.entries(bySignal).map(([signal, code]) => {
    const fn = () => { cleanup(); process.exit(code); };
    process.on(signal, fn);
    return [signal, fn];
  });
  const onCrash = (err) => { cleanup(); process.stderr.write(`night run crashed: ${err?.stack ?? err}\n`); process.exit(EXIT.stopped); };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  try {
    // The log directory is created BEFORE the pre-flight, not after it. An aborted night is the run
    // whose evidence is worth most — it is the one where something the design depends on did not
    // behave — and a directory made only on the passing path throws that away (tkt-a761e990190d).
    const startedAt = new Date().toISOString();
    const stamp = startedAt.replace(/[:.]/g, '-');
    const logDir = join(root, '.night-run', stamp);
    mkdirSync(logDir, { recursive: true });
    // The link `night:status` attributes a log by. The launcher owns `runner-<stamp>.log` and the
    // runner owns `logDir`, and until this line nothing tied either to the pid in ACTIVE — so status
    // picked a log by mtime and showed a REFUSED launch's "Aborting; no tickets were run" under a
    // healthy run's banner (tkt-166e6cfe2e2c). Written after the claim, so only a pid that really
    // owns the sentinel ever declares itself.
    process.stdout.write(`night-run pid ${process.pid} — logs ${logDir}\n`);

    // Rewritten after EVERY ticket rather than once at the end: the nights worth reading are the ones
    // that died mid-queue, and a summary written only on the way out is exactly the one they never
    // reach. Generated straight from `classify`, never transcribed (tkt-4ea4e17f1419 reads this).
    const summary = { startedAt, queue, results: [], exit: null };
    const saveSummary = () => {
      try {
        writeFileSync(join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      } catch (err) {
        process.stdout.write(`    WARNING: summary.json not written (${err?.code ?? err?.message})\n`);
      }
    };

    const pre = await preflightGuard(root, { spawnProbe });
    const probeLog = join(logDir, 'preflight-probes.log');
    const report = renderProbes(pre);
    // Failing to SAVE the evidence must never swallow the abort the evidence is about. Unguarded,
    // this write sits ahead of the message, so an ENOSPC or a swept logDir turned a loud pre-flight
    // abort into an unhandled rejection carrying no verdict — the `finally` below has already
    // deregistered the crash handler by then (review, MEDIUM).
    let saved = probeLog;
    try {
      writeProbeLog(probeLog, report);
    } catch (err) {
      saved = `NOT SAVED (${err?.code ?? err?.message ?? 'write failed'})`;
    }
    if (!pre.ok) {
      // The report is inlined as well as saved: an operator reading `did not block` needs to tell a
      // guard that never fired from a model that simply worded its answer differently, and being
      // sent to a file to find that out is how the difference gets guessed at instead.
      summary.exit = EXIT.preflight;
      saveSummary();
      process.stderr.write(
        `pre-flight FAILED: ${pre.why}\n${report}saved to ${saved}\nAborting; no tickets were run.\n`,
      );
      return EXIT.preflight;
    }
    process.stdout.write(`pre-flight: merge guard arms and disarms correctly (probes: ${saved})\n`);

    let exit = EXIT.ok;
    let neverStarted = 0;
    for (const id of queue) {
      if (fileHere(stop)) {
        // Nothing used to remove it, so a leftover STOP made every LATER run break here and report a
        // clean night; cleanup() in the finally sweeps it now, on this path as on every other.
        process.stdout.write('STOP file present — ending the queue cleanly\n');
        break;
      }
      const before = readStatus(boardDir, id);
      process.stdout.write(`\n--- ${id}  (was ${before ?? 'unreadable'})\n`);

      const res = await runSession(id, { capMs: cap.capMs, logDir, exec });
      writeFileSync(join(logDir, `${id}.log`), res.out);

      // A session that could not be spawned at all would otherwise read as "never started" and march
      // through the whole queue in silence — `claude` off PATH burns every ticket (review, MEDIUM).
      if (res.code === -1) {
        process.stdout.write(`    HALT: the session could not be started (${res.out.slice(0, 200)})\n    queue stops here\n`);
        // Recorded before the break: otherwise the machine-readable summary shows a stopped night
        // with the failing ticket ABSENT, and the reader cannot tell which one it died on.
        summary.results.push({ id, before, after: null, level: 'halt', text: 'the session could not be started', log: join(logDir, `${id}.log`) });
        exit = EXIT.stopped;
        saveSummary();
        break;
      }

      const after = readStatus(boardDir, id);
      const verdict = classify({ before, after, capped: res.capped });
      process.stdout.write(`    ${verdict.level.toUpperCase()}: ${describe(verdict, res.out)}\n`);
      summary.results.push({ id, before, after, level: verdict.level, text: verdict.text, log: join(logDir, `${id}.log`) });
      saveSummary();

      neverStarted = verdict.text.startsWith('never started') ? neverStarted + 1 : 0;
      if (neverStarted >= 2) {
        process.stdout.write('    two tickets in a row never started — something is wrong with the runner, not the board\n    queue stops here\n');
        exit = EXIT.stopped;
        break;
      }
      if (verdict.stop) {
        process.stdout.write('    queue stops here\n');
        exit = verdict.level === 'alarm' ? EXIT.alarm : EXIT.stopped;
        break;
      }
    }
    summary.exit = exit;
    saveSummary();
    process.stdout.write(`\nlogs: ${logDir}\n`);
    return exit;
  } finally {
    // A STOP written while the LAST ticket was in flight is never seen by the loop check, so the
    // sweep in cleanup() is what serves it: the run is over either way (review, MEDIUM).
    cleanup();
    for (const [signal, fn] of handlers) process.off(signal, fn);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
