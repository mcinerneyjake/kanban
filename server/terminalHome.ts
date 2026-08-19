import { mkdirSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isValidSessionId, type CredMount } from './terminalAuth.js';
import { seedHomePath, sessionsRootPath, measureSeedSize, describeSeedSize } from '../shared/terminalSeed.mjs';

// Per-session HOME isolation for the embedded terminal (S4, tkt-db09c3a52655).
//
// Every session used to mount ONE shared host dir (~/.kanban-terminal/home) as its HOME, read-write.
// Two hazards: concurrent sessions racing atomic-rename writes to ~/.claude.json could corrupt it,
// and every session could read/tamper the same evolving auth state. Fix: treat that dir as a
// read-only SEED/template and give each session its own COPY as HOME. The seed's token is a static
// long-lived subscription token (scripts/terminal-setup-cred.mjs, refreshToken:'' / +10y expiry), so
// copies never drift — auth works identically in every session with no write-back needed.
//
// Trade-off (deliberate, matches the ticket's "separate HOME copy per session"): a `/login` performed
// INSIDE a session is now ephemeral — it lives in that session's copy only, not the shared seed.
//
// `scripts/terminal-setup-cred.mjs` is the ONLY sanctioned way to seed (tkt-ea48dbc56f19). Never
// `/login` into the seed home: that writes a refreshable ~24h credential whose refresh is discarded
// with the session copy, so the seed rots and every later session prompts for login — the failure
// this design already suffered (tkt-da1caf5316f7). The dev preflight warns when the seed drifts back
// into that shape.

const CONTAINER_HOME = '/kanban-home';

// The pre-authenticated seed/template HOME. Sessions copy FROM it and never write TO it, so it stays
// small and uncorrupted. Env-overridable (tests point it at a temp dir). Resolution lives in
// shared/terminalSeed.mjs so the bare-`node` setup script resolves the identical path
// (tkt-812b2b71acbe); these stay exported as the server's names for it.
export function seedHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return seedHomePath(env);
}

// Root holding every per-session HOME, a sibling of the seed.
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return sessionsRootPath(env);
}

// A session's isolated HOME. Deterministic in the session id, so dispose/adoption/reaper can
// recompute it with no tracked state. Guarded by isValidSessionId (a v4-UUID shape, no path
// separators) so a session id that reaches us from an untrusted source — e.g. a `docker ps` LABEL
// the reaper reads, which planReap does NOT shape-check — can never traverse out of the sessions
// root on the delete path. Returns null for an invalid id; callers treat that as "no such home".
export function sessionHomeDir(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isValidSessionId(sessionId)) return null;
  return path.join(sessionsRoot(env), sessionId, 'home');
}

// Warn — never REFUSE — when the template has grown past its budget (tkt-ce65b2532e47). The ticket
// offered both; refusing trades a slow session for no session, and the 502 MB seed that paid for this
// still worked. It was the silence that cost, so the fix is noise, not a block. Same call as
// applyHostModel's unreadable path. The budget and the measurement live in shared/terminalSeed.mjs so
// this and the dev preflight cannot read two different numbers.
function warnOnSeedSize(env: NodeJS.ProcessEnv): void {
  const { level, message } = describeSeedSize(measureSeedSize(env));
  if (level === 'warn') console.error(`[terminal] ${message}`);
}

// Seed an isolated per-session HOME by copying the template into it. A stale dir from a crashed prior
// run of the same id is cleared first (a fresh, uncontaminated copy every time). Ensures .claude/
// exists so docker doesn't create it root-owned on mount. Returns the CredMount the container args
// use. Throws on an invalid id — openSession always passes a validated/minted UUID, so this only
// fires on a programming error, and refusing to provision is safer than guessing a path.
export function seedSessionHome(sessionId: string, env: NodeJS.ProcessEnv = process.env): CredMount {
  const home = sessionHomeDir(sessionId, env);
  if (home === null) throw new Error(`seedSessionHome: invalid session id ${JSON.stringify(sessionId)}`);
  const seed = seedHomeDir(env);
  warnOnSeedSize(env);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (existsSync(seed)) cpSync(seed, home, { recursive: true });
  mkdirSync(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  applyHostModel(home, readHostModel(env));
  return { hostHome: home, containerHome: CONTAINER_HOME };
}

// ── Model preference (tkt-f0288c839503) ──────────────────────────────────────
//
// The container found no `model` key anywhere in its HOME, so `claude` started on its own built-in
// default rather than the one the user's own sessions use. Deterministic, not random: the seed keeps
// `settings.json`, but nothing ever wrote a model into it.
//
// Applied to the SESSION COPY, never the seed. Two reasons: the seed is a read-only template by
// design (every writer of it is a documented hazard — see the header), and reading per session means
// changing the host model takes effect on the next session instead of waiting for a re-seed.
//
// There is no model ENV VAR to use here. Claude Code takes the model from `settings.json`, which is
// why this writes a file rather than joining the `-e` flags that carry the LLM endpoints.

export type HostModel =
  | { status: 'set'; model: string }
  | { status: 'unset' }
  | { status: 'unreadable'; reason: string };

// Exported so a test can assert the RESOLUTION rather than the contents — the fallback to the real
// ~/.claude is what makes pinning CLAUDE_CONFIG_DIR in tests load-bearing rather than decorative.
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'settings.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Three outcomes, not two. "No preference set" and "I could not read the host's settings" both end up
 * leaving the container on its own default, but only one of them is a fault — collapsing them would
 * make a corrupt settings.json indistinguishable from a deliberate absence.
 */
export function readHostModel(env: NodeJS.ProcessEnv = process.env): HostModel {
  const file = claudeSettingsPath(env);
  if (!existsSync(file)) return { status: 'unset' }; // no user settings at all is a normal state
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { status: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(parsed)) return { status: 'unreadable', reason: 'settings.json is not a JSON object' };
  const model = parsed.model;
  if (model === undefined) return { status: 'unset' };
  if (typeof model !== 'string' || !model.trim()) {
    return { status: 'unreadable', reason: `"model" is ${JSON.stringify(model)}, not a non-empty string` };
  }
  return { status: 'set', model: model.trim() };
}

/**
 * Merge the model into the session HOME's settings.json, preserving whatever the seed already put
 * there — the seed's settings are the user's too, and clobbering them to set one key would trade this
 * bug for a worse one.
 */
export function applyHostModel(home: string, host: HostModel): void {
  if (host.status === 'unreadable') {
    // Loud, and non-fatal: a session that starts on the wrong model is far better than no session.
    console.error(`[terminal] could not read the host model preference (${host.reason}); the session will use claude's own default`);
    return;
  }
  if (host.status === 'unset') return;

  const file = path.join(home, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isRecord(parsed)) settings = parsed;
      else console.error(`[terminal] ${file} is not a JSON object; replacing it with a model-only settings file`);
    } catch (err) {
      console.error(`[terminal] ${file} is unparseable (${err instanceof Error ? err.message : String(err)}); replacing it with a model-only settings file`);
    }
  }
  writeFileSync(file, `${JSON.stringify({ ...settings, model: host.model }, null, 2)}\n`, { mode: 0o600 });
}

// Remove a session's HOME (on dispose or reap). Best-effort; a missing dir is not an error, and an
// invalid id is a silent no-op (never rm outside the sessions root). Removes the session DIR, not just
// the home/ inside it — otherwise every dispose leaves an empty parent behind to accumulate forever
// (tkt-ae53ab420a02). Derived from the isValidSessionId-guarded path, so no-traversal still holds.
export function removeSessionHome(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = sessionHomeDir(sessionId, env);
  if (home === null) return;
  rmSync(path.dirname(home), { recursive: true, force: true });
}
