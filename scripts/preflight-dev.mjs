#!/usr/bin/env node
// `npm run dev` preflight (tkt-9dfae76f986f): before `concurrently` starts the dev servers, make
// sure Docker (needed by the embedded terminal) and the LM Studio server (needed by the intake
// agent) are up — offering to start each if it's down, so they aren't a manual step every session.
//
// ADVISORY, never fatal: neither service is required to serve the app, so this ALWAYS exits 0 — a
// declined prompt, a failed start, or any error prints a warning and lets `npm run dev` proceed.
// Prompting/auto-start only happens in an interactive macOS shell; CI / non-TTY / non-darwin /
// KANBAN_NO_PREFLIGHT=1 just probe-and-report so nothing ever hangs. Runs once per `npm run dev`
// (a `tsx watch` restart does NOT re-trigger a predev hook). Decision logic lives in preflight-lib.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { isDaemonUp, serverStatusFromJson, modelsLoaded, resolveProbeBase, parseYesNo, describeCheckoutFreshness } from './preflight-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`preflight: ${m}`);
const warn = (m) => console.warn(`preflight: ⚠ ${m}`);

async function ask(question, dflt = true) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return parseYesNo(await rl.question(`preflight: ${question} `), dflt);
  } finally {
    rl.close();
  }
}

function dockerUp() {
  return isDaemonUp(spawnSync('docker', ['info'], { stdio: 'ignore' }).status);
}

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts });
}

// Warn when the checkout is stale/parked — the app + embedded terminal serve whatever is checked out,
// so running behind main (or on a detached HEAD) silently ships pre-fix code (tkt-1f9c3ae13a50).
// Best-effort + never fatal: skips silently outside a git tree or with no origin/main to compare.
function checkCheckout() {
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return; // not a git work tree → skip
  // Refresh origin/main so "behind" isn't measured against a stale local ref (the guard matters most
  // right after someone else pushes to main). Short, offline-tolerant; a failed fetch falls back to
  // the last-known ref. stdio ignored so it can't prompt for creds and hang the preflight.
  git(['fetch', 'origin', 'main', '--quiet'], { timeout: 4000, stdio: 'ignore' });
  if (git(['rev-parse', '--verify', '--quiet', 'origin/main']).status !== 0) return; // no ref → skip
  const behindRes = git(['rev-list', '--count', 'HEAD..origin/main']);
  if (behindRes.status !== 0) return; // couldn't compute → skip rather than mislead
  const branchRes = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : 'HEAD';
  const t = Number.parseInt(process.env.KANBAN_STALE_WARN_COMMITS ?? '', 10);
  const threshold = Number.isInteger(t) && t >= 0 ? t : 3;
  const { level, message } = describeCheckoutFreshness({ branch, behind: Number(behindRes.stdout.trim()), threshold });
  if (level === 'warn') warn(message); else log(message);
}

async function probeModels(base) {
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Poll `fn` until truthy or the deadline; prints dots for visible progress.
async function pollUntil(fn, { timeoutMs, everyMs = 1500 }) {
  const deadline = Date.now() + timeoutMs;
  let dotted = false;
  while (Date.now() < deadline) {
    if (await fn()) { if (dotted) process.stdout.write('\n'); return true; }
    process.stdout.write('.');
    dotted = true;
    await sleep(everyMs);
  }
  if (dotted) process.stdout.write('\n');
  return false;
}

function findLms() {
  const local = path.join(homedir(), '.lmstudio', 'bin', 'lms');
  if (existsSync(local)) return local;
  const which = spawnSync('which', ['lms'], { encoding: 'utf8' });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

async function checkDocker(interactive) {
  if (dockerUp()) { log('✓ Docker running'); return; }
  if (!interactive) { warn('Docker not running — the embedded terminal will be unavailable'); return; }
  if (!(await ask('Docker isn’t running. Start it? [Y/n]', true))) {
    warn('Docker left stopped — the embedded terminal will be unavailable');
    return;
  }
  log('starting Docker Desktop…');
  spawnSync('open', ['-ga', 'Docker'], { stdio: 'ignore' });
  if (await pollUntil(() => dockerUp(), { timeoutMs: 90_000 })) log('✓ Docker ready');
  else warn('Docker did not become ready in time — continuing');
}

async function checkLmStudio(interactive, base) {
  const lms = findLms();
  if (!lms) { warn('lms CLI not found — skipping the LM Studio check'); return; }

  let running = serverStatusFromJson(spawnSync(lms, ['server', 'status', '--json'], { encoding: 'utf8' }).stdout).running;
  if (!running) {
    if (!interactive) { warn('LM Studio server not running — the intake agent will be unavailable'); return; }
    if (!(await ask('LM Studio server isn’t running. Start it? [Y/n]', true))) {
      warn('LM Studio left stopped — the intake agent will be unavailable');
      return;
    }
    log('starting LM Studio server…');
    spawnSync(lms, ['server', 'start'], { stdio: 'ignore', timeout: 25_000 });
    running = await pollUntil(async () => Boolean(await probeModels(base)), { timeoutMs: 30_000 });
    if (!running) { warn('LM Studio server did not come up in time — continuing'); return; }
    log('✓ LM Studio server ready');
  } else {
    log('✓ LM Studio server running');
  }

  // Server up != a model is loaded — the intake agent needs one. Warn only; don't pick/load for them.
  const models = await probeModels(base);
  if (models && !modelsLoaded(models)) {
    warn(`no model loaded in LM Studio — run 'lms load' (LLM_MODEL=${process.env.LLM_MODEL ?? 'see .env'})`);
  }
}

async function main() {
  try { process.loadEnvFile('.env'); } catch { /* no .env — defaults are fine */ }
  const base = resolveProbeBase(process.env);
  // Auto-start needs an interactive macOS shell; otherwise probe-and-report only (never prompt/hang).
  const interactive = Boolean(process.stdin.isTTY) && process.env.KANBAN_NO_PREFLIGHT !== '1' && process.platform === 'darwin';
  if (!interactive) log('non-interactive — checking without prompting');
  // Freshness first: "am I even running the right code?" is the most fundamental check, and it's the
  // one that would have caught the stale-checkout bug that made the terminal die on restart.
  checkCheckout();
  await checkDocker(interactive);
  await checkLmStudio(interactive, base);
}

// Never block `npm run dev`: swallow everything and exit 0.
main().catch((e) => warn(`skipped after an error: ${e?.message ?? e}`)).finally(() => process.exit(0));
