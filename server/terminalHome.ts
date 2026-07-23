import { mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { isValidSessionId, type CredMount } from './terminalAuth.js';
import { seedHomePath, sessionsRootPath } from '../shared/terminalSeed.mjs';

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

// Seed an isolated per-session HOME by copying the template into it. A stale dir from a crashed prior
// run of the same id is cleared first (a fresh, uncontaminated copy every time). Ensures .claude/
// exists so docker doesn't create it root-owned on mount. Returns the CredMount the container args
// use. Throws on an invalid id — openSession always passes a validated/minted UUID, so this only
// fires on a programming error, and refusing to provision is safer than guessing a path.
export function seedSessionHome(sessionId: string, env: NodeJS.ProcessEnv = process.env): CredMount {
  const home = sessionHomeDir(sessionId, env);
  if (home === null) throw new Error(`seedSessionHome: invalid session id ${JSON.stringify(sessionId)}`);
  const seed = seedHomeDir(env);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (existsSync(seed)) cpSync(seed, home, { recursive: true });
  mkdirSync(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  return { hostHome: home, containerHome: CONTAINER_HOME };
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
