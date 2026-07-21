// Pure decision helpers for the `npm run dev` preflight (tkt-9dfae76f986f). No I/O — every
// function maps inputs (a probe result, CLI stdout, env) to a decision, so they're unit-tested
// in isolation while scripts/preflight-dev.mjs holds the spawn/fetch/prompt I/O. Mirrors the
// terminalAuth (pure) vs terminal (I/O) split.

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
