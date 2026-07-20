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
