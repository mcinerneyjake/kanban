// Pure decision helpers for the `npm run dev` preflight (tkt-9dfae76f986f). No I/O — every
// function maps inputs (a probe result, CLI stdout, env) to a decision, so they're unit-tested
// in isolation while scripts/preflight-dev.mjs holds the spawn/fetch/prompt I/O. Mirrors the
// terminalAuth (pure) vs terminal (I/O) split.
import { validateSetupToken } from '../shared/terminalSeed.mjs';

const DEFAULT_BASE = 'http://localhost:1234/v1';

// `docker info` exit code → is the daemon up? (0 = ready, anything else = down/starting.)
export function isDaemonUp(exitCode) {
  return exitCode === 0;
}

// Parse `lms server status --json` stdout → { running, port }. Defensive: the CLI may emit a
// preamble before the JSON, so fall back to the first brace-group; any failure reads as "down".
export function serverStatusFromJson(stdout) {
  const text = String(stdout ?? '').trim();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { json = JSON.parse(match[0]); } catch { json = null; } }
  }
  return {
    running: Boolean(json && json.running),
    port: json && typeof json.port === 'number' ? json.port : null,
  };
}

// A 200 from GET /v1/models means the server is up, but NOT that a model is loaded — that needs a
// non-empty `data` array. (server-up != inference-ready.)
export function modelsLoaded(modelsJson) {
  return Boolean(modelsJson && Array.isArray(modelsJson.data) && modelsJson.data.length > 0);
}

// The base URL to probe, from LLM_BASE_URL (trailing slashes stripped) or the LM Studio default.
export function resolveProbeBase(env = {}) {
  const raw = typeof env.LLM_BASE_URL === 'string' && env.LLM_BASE_URL.trim() ? env.LLM_BASE_URL.trim() : DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

// [Y/n]-style prompt answer → boolean. Empty (bare Enter) takes the default.
export function parseYesNo(answer, dflt = true) {
  const a = String(answer ?? '').trim().toLowerCase();
  if (a === '') return dflt;
  if (a === 'y' || a === 'yes') return true;
  if (a === 'n' || a === 'no') return false;
  return dflt;
}

const RESEED_HINT = 'Re-seed: run `claude setup-token` in your own terminal, then `printf \'%s\' <token> | node scripts/terminal-setup-cred.mjs`.';

// Health of the embedded terminal's credential SEED (tkt-ea48dbc56f19). Each session copies the seed
// and mounts the throwaway copy as HOME (S4), and nothing ever writes back — so a seed holding a
// refreshable `/login` credential can never be refreshed, and every session inherits it until it dies
// (tkt-da1caf5316f7). Only a non-refreshing `claude setup-token` is stable here. Takes the PARSED
// credential (or a read/parse `error`) and maps it to a decision; preflight-dev.mjs does the file I/O.
// Never fatal — this warns, it doesn't block `npm run dev`.
export function describeSeedCredential({ credential, error = null, now = Date.now(), warnWithinDays = 14 } = {}) {
  // A seed we can't read is NOT a passing seed — say so rather than fall through to 'ok'.
  if (error) {
    return { level: 'warn', message: `terminal credential seed is unreadable (${error}) — treat it as broken. ${RESEED_HINT}` };
  }
  const oauth = credential && typeof credential === 'object' ? (credential.claudeAiOauth ?? credential) : null;
  const hasToken = Boolean(oauth && typeof oauth.accessToken === 'string' && oauth.accessToken);
  if (!hasToken) {
    return { level: 'warn', message: `no terminal credential seed — every embedded-terminal session will prompt for login. ${RESEED_HINT}` };
  }
  // The tell for seed drift. A setup-token seed carries refreshToken:'' by construction, so anything
  // here means a `/login` credential landed in the seed and its rotation is being thrown away.
  const refreshable = typeof oauth.refreshToken === 'string' && oauth.refreshToken !== '';
  const drift = refreshable
    ? ' The seed holds a `/login` credential (it has a refresh token), not a `claude setup-token` — sessions copy the seed and never write back, so each refresh is discarded.'
    : '';
  const expiresAt = Number(oauth.expiresAt);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);

  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    if (expiresAt <= now) {
      return { level: 'warn', message: `terminal credential seed EXPIRED on ${day(expiresAt)} — every new embedded-terminal session will prompt for login.${drift} ${RESEED_HINT}` };
    }
    const daysLeft = Math.ceil((expiresAt - now) / 86_400_000);
    if (daysLeft <= warnWithinDays) {
      return { level: 'warn', message: `terminal credential seed expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${day(expiresAt)}).${drift} ${RESEED_HINT}` };
    }
  }
  if (refreshable) {
    // Deliberately warn even when the local expiry looks far off: a /login credential's real lifetime
    // is ~24h regardless of what the file claims, so the expiry check alone would miss this.
    return { level: 'warn', message: `terminal credential seed will go stale.${drift} ${RESEED_HINT}` };
  }
  // Same check the seeder applies before writing, so a seed the seeder would have refused isn't
  // reported healthy here — this path used to call any non-empty string "stable", which is how a
  // truncated or wrong-shaped token stayed invisible until every session failed (tkt-bfb3bc9f98d4).
  // Ordered LAST on purpose: expiry and the refresh-token tell are precisely characterized, while the
  // token *shape* rule is the least-verified of the three, so it must not preempt a better diagnosis.
  const shape = validateSetupToken(oauth.accessToken);
  if (!shape.ok) {
    return { level: 'warn', message: `terminal credential seed holds an unusable token — ${shape.reason} ${RESEED_HINT}` };
  }
  return { level: 'ok', message: '✓ terminal credential seed looks stable (setup-token shape, no refresh token)' };
}

// Advisory freshness of the current checkout vs origin/<defaultBranch>, from the current branch name
// and how many commits behind origin the checkout is. The embedded terminal AND the app serve
// whatever branch is checked out, so a checkout far behind main — or a detached HEAD — silently runs
// stale code: the exact trap where a shared-worktree branch switch left the terminal on pre-fix code
// and it appeared to "kill itself" on every restart (tkt-1f9c3ae13a50). Maps inputs → a decision;
// preflight-dev.mjs runs the git commands and prints ✓ via log() for 'ok' / ⚠ via warn() for 'warn'.
// A checkout under `threshold` commits behind is normal feature-branch drift → 'ok' (informational).
export function describeCheckoutFreshness({ branch, behind, threshold = 3, defaultBranch = 'main' } = {}) {
  if (!branch || branch === 'HEAD') {
    return { level: 'warn', message: `detached HEAD — not on a branch; the app & embedded terminal serve this snapshot, not origin/${defaultBranch}.` };
  }
  const parsed = Number(behind);
  const behindN = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  const commits = behindN === 1 ? 'commit' : 'commits';
  if (behindN === 0) {
    return { level: 'ok', message: `✓ on ${branch}, up to date with origin/${defaultBranch}` };
  }
  if (behindN >= threshold) {
    return {
      level: 'warn',
      message: `checkout is ${behindN} ${commits} behind origin/${defaultBranch} (on ${branch}) — the app & embedded terminal serve this OLDER code. Update with \`git switch ${defaultBranch} && git pull\` (or rebase your branch).`,
    };
  }
  return { level: 'ok', message: `✓ on ${branch} (${behindN} ${commits} behind origin/${defaultBranch})` };
}
