import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { seedHomeDir, sessionsRoot, sessionHomeDir, seedSessionHome, removeSessionHome, readHostModel, applyHostModel, claudeSettingsPath } from './terminalHome.js';
import { SEED_SIZE_WARN_BYTES } from '../shared/terminalSeed.mjs';

// Two valid v4 UUID session ids (isValidSessionId shape) — the isolation must key on these.
const ID_A = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
const ID_B = '11111111-2222-4333-8444-555566667777';

describe('terminalHome (per-session HOME isolation, S4)', () => {
  let base: string;
  let seed: string;
  let env: NodeJS.ProcessEnv;
  let hostConfig: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'kanban-home-'));
    seed = path.join(base, 'kanban-terminal', 'home');
    // CLAUDE_CONFIG_DIR is pinned to a temp dir, empty by default. Without it the model lookup falls
    // back to the DEVELOPER'S real ~/.claude/settings.json, so these tests would assert one thing on
    // this machine and another in CI — where no such file exists (tkt-f0288c839503).
    hostConfig = path.join(base, 'host-claude');
    mkdirSync(hostConfig, { recursive: true });
    env = { KANBAN_TERMINAL_HOME: seed, CLAUDE_CONFIG_DIR: hostConfig };
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

  // tkt-ce65b2532e47. The round trip the unit tests in shared/terminalSeed.size.test.mjs cannot make:
  // real bytes on disk → the warning a human would actually see at session start. The seed reached
  // 502 MB once and every session copied all of it in silence; per-layer tests of the measurer and the
  // verdict would both have stayed green through that, because neither owns the wiring between them.
  describe('oversized seed (tkt-ce65b2532e47)', () => {
    // Sparse, so CREATING it is free. The cpSync that follows is not: hole preservation is
    // filesystem-dependent, so on ext4 (the CI runners) this case materializes ~50 MB into $TMPDIR
    // and removes it again. Cheap enough to keep, but do not read this as a zero-write test.
    const bloat = (bytes: number) => {
      writeFileSync(path.join(seed, '.local-share-claude'), '');
      truncateSync(path.join(seed, '.local-share-claude'), bytes);
    };

    it('warns at session start, naming the size, and still provisions the HOME', () => {
      bloat(SEED_SIZE_WARN_BYTES + 1);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mount = seedSessionHome(ID_A, env);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('over the 50.0 MB budget'));
      // Warn, never refuse: a slow session beats no session, and the 502 MB seed still worked.
      expect(readFileSync(path.join(mount.hostHome, '.claude', '.credentials.json'), 'utf8')).toContain('tok');
      err.mockRestore();
    });

    // The control. Without it, a warning hardcoded to fire on every seed would pass the case above.
    it('says nothing for a seed under the budget', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      seedSessionHome(ID_A, env);
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    // A seed that cannot be measured must not read as a seed that is fine. Here provisioning fails
    // anyway (cpSync will not copy a file over a directory) — the point is that the warning lands
    // FIRST, so the operator gets "its size is UNKNOWN" instead of a bare cpSync error.
    it('warns when the seed cannot be measured at all, before the copy fails', () => {
      rmSync(seed, { recursive: true, force: true });
      writeFileSync(seed, 'the seed path is a file, not a directory');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => seedSessionHome(ID_A, env)).toThrow();
      expect(err).toHaveBeenCalledWith(expect.stringContaining('UNKNOWN'));
      err.mockRestore();
    });
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

// tkt-f0288c839503. The container found no `model` key in its HOME, so `claude` started on its own
// built-in default instead of the one the user's own sessions use. Deterministic, not random: the
// seed keeps settings.json, but nothing ever wrote a model into it.
describe('host model preference', () => {
  let base: string;
  let seed: string;
  let hostConfig: string;
  let env: NodeJS.ProcessEnv;
  const ID = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
  const hostSettings = (json: string) => writeFileSync(path.join(hostConfig, 'settings.json'), json);
  const sessionSettings = () =>
    JSON.parse(readFileSync(path.join(sessionHomeDir(ID, env) ?? '', '.claude', 'settings.json'), 'utf8'));

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'kanban-model-'));
    seed = path.join(base, 'kanban-terminal', 'home');
    hostConfig = path.join(base, 'host-claude');
    mkdirSync(path.join(seed, '.claude'), { recursive: true });
    mkdirSync(hostConfig, { recursive: true });
    writeFileSync(path.join(seed, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"tok"}}');
    env = { KANBAN_TERMINAL_HOME: seed, CLAUDE_CONFIG_DIR: hostConfig };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('carries the host model into the session HOME (the whole bug)', () => {
    // A value no real settings file would hold. `opus[1m]` — the actual host value on the machine
    // this was written on — would have passed even if CLAUDE_CONFIG_DIR were ignored and the real
    // ~/.claude/settings.json were read instead, so it could not tell the pin from the confound.
    hostSettings('{"model":"test-model-not-a-real-alias"}');
    seedSessionHome(ID, env);
    expect(sessionSettings().model).toBe('test-model-not-a-real-alias');
  });

  it('leaves the container on its own default when the host sets no model', () => {
    // The control that makes the test above attributable to the HOST SETTING rather than to any
    // model being written: without it, a hardcoded default would pass identically.
    hostSettings('{"theme":"dark"}');
    const mount = seedSessionHome(ID, env);
    expect(existsSync(path.join(mount.hostHome, '.claude', 'settings.json'))).toBe(false);
  });

  it('does not invent a model when there are no host settings at all', () => {
    const mount = seedSessionHome(ID, env); // hostConfig is empty
    expect(existsSync(path.join(mount.hostHome, '.claude', 'settings.json'))).toBe(false);
    expect(readHostModel(env)).toEqual({ status: 'unset' });
  });

  it('preserves the seed\'s other settings instead of clobbering them to set one key', () => {
    writeFileSync(path.join(seed, '.claude', 'settings.json'), '{"theme":"dark","statusLine":"x"}');
    hostSettings('{"model":"opus"}');
    seedSessionHome(ID, env);
    expect(sessionSettings()).toEqual({ theme: 'dark', statusLine: 'x', model: 'opus' });
  });

  it('re-reads per session, so a host change lands without a re-seed', () => {
    hostSettings('{"model":"sonnet"}');
    seedSessionHome(ID, env);
    expect(sessionSettings().model).toBe('sonnet');
    hostSettings('{"model":"opus"}');
    seedSessionHome(ID, env);
    expect(sessionSettings().model).toBe('opus');
  });

  it('never writes to the seed — it is a read-only template', () => {
    hostSettings('{"model":"opus"}');
    seedSessionHome(ID, env);
    expect(existsSync(path.join(seed, '.claude', 'settings.json'))).toBe(false);
  });

  describe('the three outcomes stay distinguishable', () => {
    // "No preference set" and "I could not read the settings" both leave the container on its own
    // default, but only one is a fault. Collapsing them would make a corrupt settings.json look like
    // a deliberate absence.
    it('reports unreadable, not unset, for a corrupt or wrong-typed settings file', () => {
      for (const [json, fragment] of [
        ['{not json', 'JSON'],
        ['[1,2,3]', 'not a JSON object'],
        ['{"model":42}', 'not a non-empty string'],
        ['{"model":"   "}', 'not a non-empty string'],
      ] as const) {
        hostSettings(json);
        const result = readHostModel(env);
        expect(result.status, json).toBe('unreadable');
        expect(result.status === 'unreadable' && result.reason).toContain(fragment);
      }
    });

    it('a session still starts when the host settings are unreadable', () => {
      hostSettings('{oops');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mount = seedSessionHome(ID, env);
      expect(existsSync(path.join(mount.hostHome, '.claude', '.credentials.json'))).toBe(true);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('could not read the host model preference'));
      err.mockRestore();
    });

    it('replaces a corrupt session settings.json rather than failing the session', () => {
      writeFileSync(path.join(seed, '.claude', 'settings.json'), '{broken');
      hostSettings('{"model":"opus"}');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      seedSessionHome(ID, env);
      expect(sessionSettings()).toEqual({ model: 'opus' });
      expect(err).toHaveBeenCalledWith(expect.stringContaining('unparseable'));
      err.mockRestore();
    });
  });

  it('honours CLAUDE_CONFIG_DIR, and falls back to ~/.claude without it', () => {
    // The reason every 'unset' case above is evidence: if the env var were ignored, the lookup would
    // hit the developer's REAL settings — which does carry a model — and those tests would go red
    // here while still passing in CI, where no such file exists. Asserting the resolved PATH makes
    // the pin verifiable on both.
    expect(claudeSettingsPath(env)).toBe(path.join(hostConfig, 'settings.json'));
    expect(claudeSettingsPath({})).toBe(path.join(homedir(), '.claude', 'settings.json'));
  });

  it('applyHostModel is callable on its own, so the decision is testable apart from the copy', () => {
    const home = path.join(base, 'standalone');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    applyHostModel(home, { status: 'set', model: 'haiku' });
    expect(JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))).toEqual({ model: 'haiku' });
  });
});
