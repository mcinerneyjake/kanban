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
import { readFileSync, writeFileSync, rmSync, mkdirSync, accessSync } from 'node:fs';
import { join } from 'node:path';
import { primaryRoot } from '../.claude/hooks/guard-unattended-merge.mjs';

export const USAGE = 'usage: npm run night -- <ticket-id>...';

// The exit status is the only part of this a cron wrapper or an `|| notify-me` ever reads, so a
// stopping verdict must never share a code with a clean night (review, HIGH).
export const EXIT = { ok: 0, preflight: 1, stopped: 2, alarm: 3, usage: 64 };

// Only a clean, expected transition is an OK. Everything else either stops the queue or is reported
// as needing a human — "can't tell" never returns the permissive answer.
export function classify({ before, after, capped = false }) {
  if (capped) {
    return { level: 'capped', stop: true, text: 'hit the wall-clock cap; left mid-ticket' };
  }
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

export function gateFailed(log) {
  const text = log ?? '';
  return GATE_SUMMARY.test(text) || GATE_NAMED.test(text);
}

export function describe(result, log) {
  if (result.level === 'halt' && gateFailed(log)) {
    return `${result.text} — the quality gate failed, so this is UNDIAGNOSED, not evidence against the branch`;
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

export function run(cmd, args, { capMs, graceMs = 10_000, onOutput, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
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
  // The sentinel is claimed before this await, so a probe that hangs would park the night with every
  // merge blocked and no ticket run (review, MEDIUM).
  if (armed.capped) {
    return { ok: false, why: 'the armed guard probe timed out, so the gate could not be confirmed' };
  }
  if (!guardBlocked(armed.out)) {
    return { ok: false, why: 'the merge guard did not block while a run was marked active' };
  }

  disarm(root);
  const hook = join(root, '.claude', 'hooks', 'guard-bash.mjs');
  const off = await spawnProbe(process.execPath, [hook, join(root, '.night-run', 'NOT-THERE')], {
    input: MERGE_PROBE_PAYLOAD,
    capMs: probeCapMs,
  });
  arm(root);
  if (off.capped) {
    return { ok: false, why: 'the disarmed guard probe timed out, so the gate could not be confirmed' };
  }
  // A launcher that cannot load exits 2 as well, so this message names both readings rather than
  // asserting the one it cannot tell apart (review, MEDIUM).
  if (off.code !== 0) {
    return {
      ok: false,
      why: `the merge guard did not permit with no run active (exit ${off.code}) — it is stuck on, or the launcher itself failed to load`,
    };
  }
  return { ok: true };
}

export function sessionArgs(id) {
  return [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'auto',
    `/kanban-workflow --gates auto-pr ${id}`,
  ];
}

const defaultRunSession = (id, { capMs }) => run('claude', sessionArgs(id), { capMs });

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
  const cleanup = () => disarm(root);
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
    const pre = await preflightGuard(root, { spawnProbe });
    if (!pre.ok) {
      process.stderr.write(`pre-flight FAILED: ${pre.why}\nAborting; no tickets were run.\n`);
      return EXIT.preflight;
    }
    process.stdout.write('pre-flight: merge guard arms and disarms correctly\n');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = join(root, '.night-run', stamp);
    mkdirSync(logDir, { recursive: true });

    let exit = EXIT.ok;
    let neverStarted = 0;
    for (const id of queue) {
      if (fileHere(stop)) { process.stdout.write('STOP file present — ending the queue cleanly\n'); break; }
      const before = readStatus(boardDir, id);
      process.stdout.write(`\n--- ${id}  (was ${before ?? 'unreadable'})\n`);

      const res = await runSession(id, { capMs: cap.capMs });
      writeFileSync(join(logDir, `${id}.log`), res.out);

      // A session that could not be spawned at all would otherwise read as "never started" and march
      // through the whole queue in silence — `claude` off PATH burns every ticket (review, MEDIUM).
      if (res.code === -1) {
        process.stdout.write(`    HALT: the session could not be started (${res.out.slice(0, 200)})\n    queue stops here\n`);
        exit = EXIT.stopped;
        break;
      }

      const after = readStatus(boardDir, id);
      const verdict = classify({ before, after, capped: res.capped });
      process.stdout.write(`    ${verdict.level.toUpperCase()}: ${describe(verdict, res.out)}\n`);

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
    process.stdout.write(`\nlogs: ${logDir}\n`);
    return exit;
  } finally {
    cleanup();
    for (const [signal, fn] of handlers) process.off(signal, fn);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
