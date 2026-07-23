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
