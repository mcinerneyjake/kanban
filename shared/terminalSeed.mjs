import { homedir } from 'node:os';
import path from 'node:path';

// Where the embedded terminal's credential SEED lives. Plain .mjs, not .ts, because
// scripts/terminal-setup-cred.mjs runs under bare `node` and cannot import TypeScript — while
// server/terminalHome.ts needs the same answer. Three call sites disagreeing is not academic
// (tkt-812b2b71acbe): the preflight checked the overridden path, the setup script wrote to the
// default, and #161's rmSync then wiped a directory unrelated to the seed in use.
export function seedHomePath(env = process.env) {
  return env.KANBAN_TERMINAL_HOME ?? path.join(homedir(), '.kanban-terminal', 'home');
}

// Per-session HOMEs live in a sibling of the seed, so the override moves both together.
export function sessionsRootPath(env = process.env) {
  return path.join(path.dirname(seedHomePath(env)), 'sessions');
}

// `claude setup-token` values are `sk-ant-oat…` + ~100 chars. The length floor sits far below the
// observed 108–110 so a real token can never trip it — it catches a paste that grabbed a fragment.
// `oat` (not the full `oat01`) tolerates a future version bump; `sk-ant-` alone would NOT, because it
// also matches an API key `sk-ant-api03-…`, the single most likely wrong clipboard (tkt-bfb3bc9f98d4).
const TOKEN_PREFIX = 'sk-ant-oat';
const MIN_TOKEN_LENGTH = 40;

// Shared so the writer (terminal-setup-cred) and the reader (preflight's describeSeedCredential)
// agree on what a usable token looks like — otherwise the preflight keeps calling a seed "stable"
// that the seeder would have refused to write. `force` is the escape hatch for a legitimate token
// whose shape changes before this code does.
export function validateSetupToken(token, { force = false } = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, reason: 'No token provided.' };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, reason: `Token is only ${token.length} characters — that looks like a truncated paste, not a setup-token.` };
  }
  // Whitespace means the paste was cut short: the interactive prompt reads a single line, so a token
  // wrapped across lines arrives already truncated with the break still in it.
  if (/\s/.test(token)) {
    return { ok: false, reason: 'Token contains whitespace — a token copied across a line break arrives truncated. Re-copy it as one unbroken line.' };
  }
  if (!token.startsWith(TOKEN_PREFIX) && !force) {
    return { ok: false, reason: `Token does not start with "${TOKEN_PREFIX}" — an API key (sk-ant-api…) or a URL is the usual mistake here. Re-run with --force if you are certain it is correct.` };
  }
  return { ok: true, reason: null };
}
