import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedHomeDir, sessionsRoot, sessionHomeDir, seedSessionHome, removeSessionHome } from './terminalHome.js';

// Two valid v4 UUID session ids (isValidSessionId shape) — the isolation must key on these.
const ID_A = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
const ID_B = '11111111-2222-4333-8444-555566667777';

describe('terminalHome (per-session HOME isolation, S4)', () => {
  let base: string;
  let seed: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'kanban-home-'));
    seed = path.join(base, 'kanban-terminal', 'home');
    env = { KANBAN_TERMINAL_HOME: seed };
    // Seed a pre-authenticated template: a credentials file + a claude.json, as setup-cred would leave.
    mkdirSync(path.join(seed, '.claude'), { recursive: true });
    writeFileSync(path.join(seed, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"tok"}}');
    writeFileSync(path.join(seed, '.claude.json'), '{"onboarded":true}');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('derives session paths as siblings of the seed, deterministic in the id', () => {
    expect(seedHomeDir(env)).toBe(seed);
    expect(sessionsRoot(env)).toBe(path.join(base, 'kanban-terminal', 'sessions'));
    expect(sessionHomeDir(ID_A, env)).toBe(path.join(base, 'kanban-terminal', 'sessions', ID_A, 'home'));
    expect(sessionHomeDir(ID_A, env)).not.toBe(sessionHomeDir(ID_B, env)); // distinct id → distinct dir
  });

  it('seeds a per-session HOME that is a full copy of the template', () => {
    const mount = seedSessionHome(ID_A, env);
    expect(mount.hostHome).toBe(sessionHomeDir(ID_A, env));
    expect(mount.containerHome).toBe('/kanban-home');
    expect(readFileSync(path.join(mount.hostHome, '.claude', '.credentials.json'), 'utf8')).toContain('tok');
    expect(readFileSync(path.join(mount.hostHome, '.claude.json'), 'utf8')).toContain('onboarded');
    expect(existsSync(path.join(mount.hostHome, '.claude'))).toBe(true);
  });

  it('isolates sessions: a write in one HOME never reaches another or the seed', () => {
    const a = seedSessionHome(ID_A, env).hostHome;
    const b = seedSessionHome(ID_B, env).hostHome;
    writeFileSync(path.join(a, '.claude.json'), '{"onboarded":true,"dirty":"a"}'); // simulate a's runtime write
    expect(readFileSync(path.join(b, '.claude.json'), 'utf8')).not.toContain('dirty'); // b untouched
    expect(readFileSync(path.join(seed, '.claude.json'), 'utf8')).not.toContain('dirty'); // seed untouched
  });

  it('clears a stale HOME from a crashed prior run of the same id before re-seeding', () => {
    const home = path.join(sessionsRoot(env), ID_A, 'home'); // == sessionHomeDir(ID_A), as a plain string
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'junk.txt'), 'stale');
    seedSessionHome(ID_A, env);
    expect(existsSync(path.join(home, 'junk.txt'))).toBe(false); // stale content gone
    expect(existsSync(path.join(home, '.claude', '.credentials.json'))).toBe(true); // fresh seed present
  });

  it('still provisions a usable HOME when no seed template exists (unauthenticated first run)', () => {
    rmSync(seed, { recursive: true, force: true });
    const mount = seedSessionHome(ID_A, env);
    expect(existsSync(mount.hostHome)).toBe(true);
    expect(existsSync(path.join(mount.hostHome, '.claude'))).toBe(true); // .claude ensured so docker won't root-own it
    expect(existsSync(path.join(mount.hostHome, '.claude', '.credentials.json'))).toBe(false); // nothing to copy
  });

  it('removeSessionHome deletes the session dir and is a no-op when already gone', () => {
    const home = seedSessionHome(ID_A, env).hostHome;
    expect(existsSync(home)).toBe(true);
    removeSessionHome(ID_A, env);
    expect(existsSync(home)).toBe(false);
    // The PARENT too — asserting only home/ is what let empty session dirs pile up (tkt-ae53ab420a02).
    expect(existsSync(path.dirname(home))).toBe(false);
    expect(existsSync(sessionsRoot(env))).toBe(true); // but never the sessions root itself
    expect(() => removeSessionHome(ID_A, env)).not.toThrow(); // idempotent
  });

  it('leaves no residue behind after a seed/remove cycle, and spares other sessions', () => {
    seedSessionHome(ID_A, env);
    const keep = seedSessionHome(ID_B, env).hostHome;
    removeSessionHome(ID_A, env);
    expect(readdirSync(sessionsRoot(env))).toEqual([ID_B]);
    expect(existsSync(keep)).toBe(true);
  });

  // Defense-in-depth: the reaper derives a home path from a `docker ps` LABEL (not shape-checked by
  // planReap), so a traversal-laden id must never escape the sessions root on the delete path.
  it('refuses an invalid/traversal session id — no path escape', () => {
    const outside = path.join(base, 'kanban-terminal', 'home', '.claude.json'); // a file above sessions/
    expect(existsSync(outside)).toBe(true);
    for (const bad of ['../../etc', 'not-a-uuid', '', 'a/b/c']) {
      expect(sessionHomeDir(bad, env)).toBeNull();
      expect(() => removeSessionHome(bad, env)).not.toThrow(); // no-op, never rm's outside
      expect(() => seedSessionHome(bad, env)).toThrow(/invalid session id/);
    }
    expect(existsSync(outside)).toBe(true); // nothing above sessions/ was touched
  });
});
