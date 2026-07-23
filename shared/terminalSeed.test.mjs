import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { seedHomePath, sessionsRootPath } from './terminalSeed.mjs';
import { seedHomeDir, sessionsRoot } from '../server/terminalHome.js';

// A .mjs test on purpose: it can import BOTH the bare-node module and the TypeScript server module,
// which is the only place the two sides of this seam can be compared (tkt-812b2b71acbe).

describe('seed path resolution', () => {
  it('honors KANBAN_TERMINAL_HOME', () => {
    expect(seedHomePath({ KANBAN_TERMINAL_HOME: '/tmp/seed' })).toBe('/tmp/seed');
    expect(sessionsRootPath({ KANBAN_TERMINAL_HOME: '/tmp/seed' })).toBe(path.join('/tmp', 'sessions'));
  });

  it('falls back to ~/.kanban-terminal/home when unset', () => {
    expect(seedHomePath({})).toBe(path.join(homedir(), '.kanban-terminal', 'home'));
    expect(sessionsRootPath({})).toBe(path.join(homedir(), '.kanban-terminal', 'sessions'));
  });

  // The actual invariant: the server's mount and the scripts' target are the SAME directory. Before
  // this, the preflight checked the override, the setup script wrote to the default, and #161's
  // rmSync wiped whichever one wasn't in use.
  it('agrees with the server for both the override and the default', () => {
    for (const env of [{ KANBAN_TERMINAL_HOME: '/tmp/seed-x' }, {}]) {
      expect(seedHomeDir(env)).toBe(seedHomePath(env));
      expect(sessionsRoot(env)).toBe(sessionsRootPath(env));
    }
  });

  // Comparing the exported functions can't prove the SCRIPTS call them — the drift was a hardcoded
  // literal, so the assertion has to be about the source. Goes red the moment one is re-hardcoded.
  it('leaves no call site resolving the seed path on its own', () => {
    for (const file of ['../scripts/terminal-setup-cred.mjs', '../scripts/preflight-dev.mjs', '../server/terminalHome.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(src).toMatch(/from '.*terminalSeed\.mjs'/);
      expect(src).not.toMatch(/'\.kanban-terminal'/); // the literal that used to be pasted three times
    }
  });

  it('moves the sessions root with the seed, so an override cannot split them', () => {
    const env = { KANBAN_TERMINAL_HOME: '/tmp/custom/home' };
    expect(path.dirname(seedHomePath(env))).toBe(path.dirname(sessionsRootPath(env)));
  });
});
