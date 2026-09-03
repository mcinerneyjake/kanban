#!/usr/bin/env node
// Detached launcher and observer for the audited night runner (tkt-999d1adc3aa4). `night-run.mjs`
// keeps sole ownership of the sentinel and the queue; this file only starts one, watches it, and
// asks it to stop. Every primitive below is imported, never reimplemented.
//
// WHY DETACHED: `npm run night` dies with the Claude session that launched it. The queue is supposed
// to outlive the session, so the child gets its own process group and its stdio goes to a file.
//
// `cwd: root` IS LOAD-BEARING, and diverges from plain `npm run night` on purpose. The runner's
// `boardDir` defaults to `process.cwd()` and `readStatus` reads `<cwd>/tickets/<id>.md`
// (night-run.mjs:82-89, :333). `tickets/` is gitignored, so it does not exist in a worktree — a run
// launched from one reads EVERY status as null and classifies every ticket as "status unreadable".
// Launching from `primaryRoot()` fixes that here. `npm run night` stays bitten by it: that is
// tkt-03f3b545fdcf, not something this file quietly half-fixes.
//
// CONFINEMENT: `start` only ever launches inside NIGHT_RUN_BOUNDARY, and an unset boundary REFUSES
// rather than defaulting — an unbounded launcher spawning a detached process at whatever
// `primaryRoot()` returns is what this check exists to prevent. `status` and `stop` are deliberately
// NOT bounded; see boundedRoot. The boundary is configured machine-locally because this repo is
// public and the workspace path is not ours to publish.
//
// HARNESS-TIMEOUT TRAP: the Bash tool defaults to a 120s timeout and the pre-flight deadline below is
// 420s, so a default-length `night:start` gets killed by the harness. That is harmless — this process
// is only an observer and the detached runner is in its own session, still going — but it reads as a
// failure. Call with `timeout: 540000`, or pass `--no-wait`.

import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EXIT, PROBE_CAP_MS, sentinelPaths, ownerOf, pidAlive, fileHere, readStatus,
} from './night-run.mjs';
import { primaryRoot } from '../.claude/hooks/guard-unattended-merge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'night-run.mjs');

export const CONTROL_USAGE =
  'usage: npm run night:start -- <ticket-id>... [--no-wait] [--wait-seconds N]\n' +
  '       npm run night:status\n' +
  '       npm run night:stop [--now]';

// A run that has not claimed the sentinel within this window has almost always lost it to another
// run. Answering that in five seconds is the whole point of splitting the wait in two.
export const CLAIM_WAIT_MS = 5_000;
// Derived, never transcribed: preflightGuard runs two probes back to back, each capped at
// PROBE_CAP_MS, plus a margin for process start-up.
export const DEFAULT_WAIT_MS = PROBE_CAP_MS * 2 + 60_000;
const POLL_MS = 250;

// The runner writes exactly one of these to stdout before it touches a ticket.
const PREFLIGHT_OK = /^pre-flight: /m;
const PREFLIGHT_FAILED = /^pre-flight FAILED/m;

/**
 * THE LINE THAT DECIDES A NIGHT STARTED. Kept as its own function because everything downstream —
 * the exit status, whether the operator is told merges are gated — hangs off it, and "no marker yet"
 * must never collapse into "ok". A null here means undecided, which the caller treats as failure.
 */
export function readVerdict(text) {
  if (PREFLIGHT_FAILED.test(text ?? '')) return 'failed';
  if (PREFLIGHT_OK.test(text ?? '')) return 'ok';
  return null;
}

// Symlinks are resolved before comparing: `resolve` normalises `..` and trailing separators but
// follows nothing, so a contained path reached through a symlinked prefix would be refused and a
// symlink pointing OUT of the boundary would pass. A path that does not exist yet keeps its
// lexical form — there is nothing to follow.
const realOrLexical = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Is `root` inside `boundary`? The separator in the prefix test is load-bearing: a bare
 * `startsWith` accepts a SIBLING whose name merely begins with the boundary's, so `<boundary>-other`
 * would pass as contained. Equality is allowed — the boundary itself is in bounds.
 */
export function withinBoundary(root, boundary) {
  if (!boundary) {
    return { ok: false, why: 'NIGHT_RUN_BOUNDARY is not set, so the workspace this may run in cannot be confirmed — refusing. Set it to the directory the runner is allowed under.' };
  }
  // A relative boundary silently binds to the launcher's cwd, so the SAME value would mean different
  // directories depending on where it was invoked from. That is not a boundary.
  if (!isAbsolute(boundary)) {
    return { ok: false, why: `NIGHT_RUN_BOUNDARY must be an absolute path, got ${JSON.stringify(boundary)}` };
  }
  const b = realOrLexical(boundary);
  const r = realOrLexical(root);
  // `b + sep` would be `//` when the boundary is the filesystem root, which nothing starts with.
  const prefix = b.endsWith(sep) ? b : b + sep;
  if (r !== b && !r.startsWith(prefix)) {
    return { ok: false, why: `refusing: the resolved root ${r} is outside NIGHT_RUN_BOUNDARY (${b})` };
  }
  return { ok: true };
}

/**
 * Only `start` is bounded. Narrowing this to cover `status` and `stop` as well looked more
 * conservative and was the opposite: with no boundary configured — the normal state inside a
 * worktree, which carries no `.env` — it removed the operator's only way to inspect or END a run
 * whose sentinel is already blocking every merge, leaving "delete the file by hand" as the recovery
 * path. Refusing to LAUNCH unbounded is safe; refusing to STOP is a denial of service on the
 * recovery path (review, MEDIUM). Neither verb can wander: both act only on the resolved root of
 * this repo.
 */
function boundedRoot({ resolveRoot, boundary, err }, { bounded = true } = {}) {
  const root = resolveRoot();
  if (!root) {
    err.write('could not locate the primary checkout, so the sentinel the guard reads cannot be found\n');
    return null;
  }
  if (!bounded) return root;
  const check = withinBoundary(root, boundary);
  if (!check.ok) {
    err.write(`${check.why}\n`);
    return null;
  }
  return root;
}

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const ids = [];
  let wait = true;
  let waitMs = DEFAULT_WAIT_MS;
  let hard = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--no-wait') { wait = false; continue; }
    if (a === '--now') { hard = true; continue; }
    if (a === '--wait-seconds') {
      const raw = rest[i + 1];
      i += 1;
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, why: `--wait-seconds must be a positive number of seconds, got ${JSON.stringify(raw)}` };
      }
      waitMs = seconds * 1000;
      continue;
    }
    if (a.startsWith('--')) return { ok: false, why: `unknown flag ${a}` };
    ids.push(a);
  }
  return { ok: true, verb, ids, wait, waitMs, hard };
}

// The runner is a process-group leader when this launcher started it (`detached: true`), which is
// what makes signalling the whole group possible — see stopRun.
const defaultPgidOf = (pid) => {
  const res = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  const pgid = Number.parseInt(res.stdout.trim(), 10);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
};

const defaultCommandOf = (pid) => {
  const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  return res.stdout.trim();
};

/**
 * Who holds the sentinel, and is it really a night run? `pidAlive` alone answers the wrong question:
 * pids are reused, so a dead runner's number can belong to somebody's editor and read as a healthy
 * night. Every "cannot tell" branch gets its own kind rather than folding into `live` — a status
 * that cannot confirm a night run must not report one. (The same hole inside `claimSentinel` is
 * tkt-bbb2735702ba; this file does not touch it.)
 */
export function ownerState(root, { alive = pidAlive, commandOf = defaultCommandOf } = {}) {
  const { active } = sentinelPaths(root);
  if (!fileHere(active)) return { kind: 'absent' };
  const pid = ownerOf(root);
  if (pid === null) return { kind: 'unreadable' };
  if (!alive(pid)) return { kind: 'dead', pid };
  const cmd = commandOf(pid);
  if (cmd === null) return { kind: 'unknown-command', pid };
  if (!cmd.includes('night-run.mjs')) return { kind: 'foreign', pid, cmd };
  // Ids are read from whole ARGUMENTS after the runner path, never scraped from the command string:
  // a checkout under `.claude/worktrees/tkt-<id>-slug` puts a ticket id in the path itself, and a
  // free `matchAll` reports it as queued work that was never queued (measured on this ticket).
  const argv = cmd.split(/\s+/);
  const at = argv.findIndex((t) => t.includes('night-run.mjs'));
  const queue = at === -1 ? [] : argv.slice(at + 1).filter((t) => /^tkt-[0-9a-f]{12}$/.test(t));
  return { kind: 'live', pid, cmd, queue };
}

const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function pollUntil(check, { deadlineMs, sleep, now }) {
  const end = now() + deadlineMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (now() >= end) return null;
    await sleep(POLL_MS);
  }
}

const readIfThere = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const tail = (text, n) => {
  const lines = (text ?? '').split('\n').filter((l) => l !== '');
  return lines.length > n ? lines.slice(-n) : lines;
};

const newestMatching = (dir, pred) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const scored = entries.filter(pred).map((name) => {
    try {
      return { name, at: statSync(join(dir, name)).mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean);
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.at - a.at);
  return scored[0];
};

const since = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

async function start(args, deps) {
  const { out, err, spawnFn, openLog, now, sleep, alive, commandOf } = deps;

  const bad = args.ids.filter((id) => !/^tkt-[0-9a-f]{12}$/.test(id));
  if (args.ids.length === 0 || bad.length > 0) {
    // Caught here rather than in the child: a detached runner's usage error lands in a log nobody is
    // watching, so a typo would read as a night that quietly ran nothing.
    err.write(`${bad.length ? `not a ticket id: ${bad.join(', ')}\n` : 'no ticket ids given\n'}${CONTROL_USAGE}\n`);
    return EXIT.usage;
  }

  const root = boundedRoot(deps);
  if (!root) return EXIT.preflight;

  const dir = join(root, '.night-run');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(dir, `runner-${stamp}.log`);
  const fd = openLog(logPath);

  let exited = null;
  let spawnError = null;
  const child = spawnFn(process.execPath, [RUNNER, ...args.ids], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  // A spawn that fails never emits 'exit', and with no 'error' listener the poll below would run to
  // its full deadline before reporting a child that never existed.
  child.on('error', (e) => { spawnError = e; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.unref();

  const pid = child.pid;
  out.write(`runner pid ${pid ?? '(none)'} — log ${logPath}\n`);

  const claimed = await pollUntil(
    () => (spawnError ? 'error' : exited ? 'exited' : ownerOf(root) === pid ? 'claimed' : null),
    { deadlineMs: CLAIM_WAIT_MS, sleep, now },
  );
  if (claimed === 'error') {
    err.write(`the runner could not be started (${String(spawnError)})\n`);
    return EXIT.stopped;
  }
  if (claimed === 'exited' || claimed === null) {
    const owner = ownerOf(root);
    const why = claimed === 'exited'
      ? `the runner exited immediately (code ${exited.code}, signal ${exited.signal ?? 'none'})`
      : `the runner did not claim the sentinel within ${CLAIM_WAIT_MS / 1000}s`;
    err.write(`${why}${owner && owner !== pid ? ` — pid ${owner} already holds it` : ''}\n${readIfThere(logPath)}`);
    return EXIT.stopped;
  }

  if (!args.wait) {
    out.write(`sentinel claimed by pid ${pid}; queue: ${args.ids.join(' ')}\npre-flight NOT waited for (--no-wait) — check with: npm run night:status\n`);
    return EXIT.ok;
  }

  // `exited` is tested FIRST. Reading the verdict first meant a runner that printed its pre-flight
  // line and then stopped resolved to 'ok', and a stopped runner was announced as a started night —
  // reachable in one poll interval whenever a leftover STOP file makes the runner pass pre-flight,
  // break out of the queue and disarm (review, CRITICAL; reproduced, exit 0 with the sentinel gone).
  const verdict = await pollUntil(
    () => (exited ? 'exited' : readVerdict(readIfThere(logPath))),
    { deadlineMs: args.waitMs, sleep, now },
  );

  // A passing pre-flight is necessary but NOT sufficient: the success line claims merges are gated
  // right now, so the sentinel must still be held by this child at the moment we say so.
  if (verdict === 'ok') {
    const owner = ownerOf(root);
    if (!exited && owner === pid) {
      out.write(
        `pre-flight confirmed — the merge guard blocks while armed and permits while disarmed.\n` +
        `night run started: pid ${pid}\n` +
        `queue: ${args.ids.join(' ')}\n` +
        `log: ${logPath}\n` +
        `\`gh pr merge\` is now BLOCKED in ${root} until this run ends (npm run night:stop).\n`,
      );
      return EXIT.ok;
    }
    err.write(
      `the runner passed its pre-flight and then STOPPED — NO night is running and merges are NOT gated.\n` +
      `${owner === null ? 'The sentinel has been released.' : `The sentinel is now held by pid ${owner}.`}\n` +
      `A leftover STOP file is the usual cause; check the log and start again.\nlog: ${logPath}\n${tail(readIfThere(logPath), 20).join('\n')}\n`,
    );
    return EXIT.preflight;
  }

  // Everything below is a non-start. The child is deliberately left alone on the deadline path: slow
  // is not broken, and killing a runner that is merely still probing would destroy the evidence.
  const log = readIfThere(logPath);
  if (verdict === 'failed' || verdict === 'exited') {
    const state = ownerState(root, { alive, commandOf });
    // The log is re-read because `exited` short-circuits the poll: the runner may have printed a
    // verdict in the same interval it died, and "exited having passed" reads very differently from
    // "exited saying nothing".
    const late = readVerdict(log);
    const headline = verdict === 'failed' || late === 'failed'
      ? 'pre-flight FAILED'
      : `the runner exited ${late === 'ok' ? 'just after passing its pre-flight' : 'before reporting a pre-flight verdict'} (code ${exited?.code}, signal ${exited?.signal ?? 'none'})`;
    // Never point `--now` at a CONFIRMED live run: that would SIGTERM somebody else's healthy night
    // to tidy up after ours (review, LOW).
    const advice = state.kind === 'absent' ? ''
      : state.kind === 'live'
        ? `sentinel is held by a live night run (pid ${state.pid}) — leave it alone; it is not yours.\n`
        : `sentinel still present (${state.kind}); clear it with: npm run night:stop -- --now\n`;
    err.write(`${headline} — no night was started.\n${log}${advice}`);
    return EXIT.preflight;
  }
  err.write(
    `pre-flight NOT confirmed after ${Math.round(args.waitMs / 1000)}s — the runner (pid ${pid}) is still going and has NOT been killed.\n` +
    `Do not assume a night is running: watch it with \`npm run night:status\`, or end it with \`npm run night:stop\`.\n` +
    `log: ${logPath}\n${tail(log, 20).join('\n')}\n`,
  );
  return EXIT.preflight;
}

function status(deps) {
  const { out, alive, commandOf, now } = deps;
  const root = boundedRoot(deps, { bounded: false });
  if (!root) return EXIT.preflight;

  const { active, stop } = sentinelPaths(root);
  const dir = join(root, '.night-run');
  const state = ownerState(root, { alive, commandOf });
  const lines = [`root: ${root}`];

  if (state.kind === 'absent') {
    lines.push('sentinel: NOT armed — no night run is active, and `gh pr merge` is not gated here.');
  } else {
    let armedAt;
    try { armedAt = statSync(active).mtimeMs; } catch { armedAt = null; }
    const elapsed = armedAt === null ? 'unknown' : since(now() - armedAt);
    lines.push(`sentinel: ARMED (${active}), ${elapsed} ago — \`gh pr merge\` is BLOCKED in this checkout.`);
    switch (state.kind) {
      case 'live':
        lines.push(`owner: pid ${state.pid}, alive, running night-run.mjs`);
        lines.push(`queue: ${state.queue.length ? state.queue.join(' ') : '(none named on its command line)'}`);
        break;
      case 'foreign':
        lines.push(`owner: pid ${state.pid} is alive but is NOT a night run — stale, reused pid. Command: ${state.cmd}`);
        lines.push('The gate is held by a sentinel nobody owns; clear it with `npm run night:stop -- --now`.');
        break;
      case 'unknown-command':
        lines.push(`owner: pid ${state.pid} is alive but its command could not be read, so it cannot be confirmed as a night run.`);
        break;
      case 'dead':
        lines.push(`owner: pid ${state.pid} is GONE — a crashed run left the gate armed. Clear it with \`npm run night:stop -- --now\`.`);
        break;
      default:
        lines.push('owner: the sentinel exists but its pid could not be parsed — remove it by hand if no night run is going.');
    }
  }

  lines.push(`STOP: ${fileHere(stop) ? `present (${stop}) — the queue ends after the ticket in flight` : 'absent'}`);

  const log = newestMatching(dir, (n) => /^runner-.*\.log$/.test(n));
  if (!log) {
    lines.push('runner log: none in .night-run/');
  } else {
    const text = readIfThere(join(dir, log.name));
    lines.push(`runner log: ${log.name}`);
    lines.push(...tail(text, 12).map((l) => `  | ${l}`));
    // The runner prints `--- <id>` as it picks each ticket up, so the last one is the ticket in flight.
    const inFlight = [...text.matchAll(/^--- (tkt-[0-9a-f]{12})/gm)].at(-1)?.[1] ?? null;
    // Gated on a LIVE owner: the newest runner log outlives the run that wrote it, so after a
    // finished night this block cheerfully reported a ticket as "in flight" with nothing running
    // (review, LOW). The log and the stamp directory are also independent newest-of picks.
    if (inFlight && state.kind === 'live') {
      const board = readStatus(root, inFlight);
      lines.push(`in flight: ${inFlight} (board status now ${board ?? 'unreadable'})`);
      const runDir = newestMatching(dir, (n) => /^\d{4}-/.test(n));
      const live = runDir ? readIfThere(join(dir, runDir.name, `${inFlight}.live.log`)) : '';
      lines.push(live ? `live tail (${inFlight}.live.log):` : `live tail: none yet for ${inFlight}`);
      lines.push(...tail(live, 12).map((l) => `  | ${l}`));
    }
  }

  out.write(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

function stopRun(args, deps) {
  const { out, err, alive, commandOf, kill, pgidOf } = deps;
  const root = boundedRoot(deps, { bounded: false });
  if (!root) return EXIT.preflight;
  const { stop } = sentinelPaths(root);
  const state = ownerState(root, { alive, commandOf });

  // Writing STOP with nothing armed leaves a LANDMINE: the next run breaks out of its queue before
  // any ticket, having run nothing, and reports a clean night. The old order wrote the file and then
  // announced there was nothing to stop (review, MEDIUM).
  if (state.kind === 'absent') {
    out.write(`No night run is active (no sentinel at ${sentinelPaths(root).active}), so there is nothing to stop and no STOP file was written.\n`);
    return EXIT.ok;
  }

  mkdirSync(join(root, '.night-run'), { recursive: true });
  writeFileSync(stop, `${new Date().toISOString()}\n`);
  out.write(`wrote ${stop} — the queue ends cleanly after the ticket in flight.\n`);

  if (!args.hard) return EXIT.ok;
  // --now signals the owner. A pid that cannot be CONFIRMED as a night run is never signalled: pids
  // are reused, and SIGTERM to the wrong one kills a stranger's process to tidy up our own file.
  if (state.kind === 'live') {
    // THE PROCESS GROUP, not the pid. The runner's signal handler disarms the sentinel and exits,
    // but never touches the `claude` session it spawned — that child is not detached, so it is
    // merely orphaned and keeps running. Signalling the pid alone therefore REMOVED the merge gate
    // and left a live `--gates auto-pr` session free to merge: the exact thing the sentinel exists
    // to prevent (review, HIGH). The runner leads its own group because the launcher spawns it
    // detached; a runner started another way may not, and then the child genuinely can survive.
    const pgid = pgidOf(state.pid);
    if (pgid === state.pid) {
      kill(-state.pid, 'SIGTERM');
      out.write(`sent SIGTERM to process group ${state.pid} — the runner and the session it is driving both stop, and it disarms the sentinel on the way out.\n`);
      return EXIT.ok;
    }
    kill(state.pid, 'SIGTERM');
    out.write(
      `sent SIGTERM to pid ${state.pid} only — it is not a process-group leader (pgid ${pgid ?? 'unreadable'}), so a session it spawned may SURVIVE this signal and is no longer merge-gated once the sentinel clears. Check for a stray \`claude\` process.\n`,
    );
    return EXIT.ok;
  }
  if (state.kind === 'dead' || state.kind === 'unreadable') {
    out.write(`nothing to signal (${state.kind === 'dead' ? 'the owner pid is gone' : 'the sentinel pid could not be parsed'}); remove ${sentinelPaths(root).active} by hand to clear the gate.\n`);
    return EXIT.ok;
  }
  err.write(`refusing to signal pid ${state.pid}: it could not be confirmed as a night run (${state.kind}). Kill it by hand if you are sure.\n`);
  return EXIT.stopped;
}

export async function main(argv = process.argv.slice(2), {
  resolveRoot = primaryRoot,
  boundary = process.env.NIGHT_RUN_BOUNDARY,
  spawnFn = spawn,
  openLog = (p) => openSync(p, 'a'),
  now = Date.now,
  sleep = realSleep,
  alive = pidAlive,
  commandOf = defaultCommandOf,
  pgidOf = defaultPgidOf,
  kill = process.kill.bind(process),
  out = process.stdout,
  err = process.stderr,
} = {}) {
  const args = parseArgs(argv);
  if (!args.ok) {
    err.write(`${args.why}\n${CONTROL_USAGE}\n`);
    return EXIT.usage;
  }
  const deps = { resolveRoot, boundary, spawnFn, openLog, now, sleep, alive, commandOf, pgidOf, kill, out, err };
  switch (args.verb) {
    case 'start': return start(args, deps);
    case 'status': return status(deps);
    case 'stop': return stopRun(args, deps);
    default:
      err.write(`${args.verb ? `unknown verb ${args.verb}` : 'no verb given'}\n${CONTROL_USAGE}\n`);
      return EXIT.usage;
  }
}

// `file://${argv[1]}` is not a URL: a path needing percent-encoding (a space, a `#`) never matches
// its own `import.meta.url`, so the CLI would do nothing and exit 0 — a silent success in the one
// file whose contract is never to report one (review, LOW).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
