import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGithubSeed, buildHostsYml, buildGitconfig } from './terminal-setup-github.mjs';

const SCRIPT = fileURLToPath(new URL('./terminal-setup-github.mjs', import.meta.url));
const CRED_SCRIPT = fileURLToPath(new URL('./terminal-setup-cred.mjs', import.meta.url));
const FINE = `github_pat_${'a'.repeat(82)}`;
const CLAUDE_TOKEN = `sk-ant-oat01-${'a'.repeat(97)}`;

describe('buildHostsYml / buildGitconfig (pure)', () => {
  it('writes the gh token + https protocol, with an optional user line', () => {
    const withUser = buildHostsYml(FINE, 'octocat');
    expect(withUser).toContain(`oauth_token: ${FINE}`);
    expect(withUser).toContain('user: octocat');
    expect(withUser).toContain('git_protocol: https');
    // user is optional — gh fills it from the API if absent, so it must not be forced.
    expect(buildHostsYml(FINE, null)).not.toContain('user:');
  });

  it('gitconfig delegates HTTPS auth to gh and rewrites SSH remotes to HTTPS', () => {
    const cfg = buildGitconfig();
    expect(cfg).toContain('helper = !gh auth git-credential');
    expect(cfg).toContain('insteadOf = git@github.com:');
    expect(cfg).toContain('insteadOf = ssh://git@github.com/');
    // No raw token in the gitconfig — the token lives only in hosts.yml.
    expect(cfg).not.toContain(FINE);
  });
});

describe('terminal-setup-github end to end', () => {
  let base, seedHome, env;
  const run = (token, args = []) => execFileSync('node', [SCRIPT, ...args], { input: token, env, encoding: 'utf8' });
  const runCred = (token) => execFileSync('node', [CRED_SCRIPT], { input: token, env, encoding: 'utf8' });
  const hostsFile = () => path.join(seedHome, '.config', 'gh', 'hosts.yml');
  const gitconfigFile = () => path.join(seedHome, '.gitconfig');

  const seedClaude = () => {
    mkdirSync(path.join(seedHome, '.claude'), { recursive: true });
    writeFileSync(path.join(seedHome, '.claude', '.credentials.json'), '{"claude":"cred"}');
    writeFileSync(path.join(seedHome, '.claude.json'), '{"hasCompletedOnboarding":true}');
  };

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'seedgh-'));
    seedHome = path.join(base, 'kanban-terminal', 'home');
    env = { ...process.env, KANBAN_TERMINAL_HOME: seedHome };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('seeds hosts.yml + .gitconfig with locked-down permissions', () => {
    run(FINE, ['--user', 'octocat']);
    expect(readFileSync(hostsFile(), 'utf8')).toContain(`oauth_token: ${FINE}`);
    expect(readFileSync(gitconfigFile(), 'utf8')).toContain('!gh auth git-credential');
    expect(statSync(hostsFile()).mode & 0o777).toBe(0o600);
    expect(statSync(gitconfigFile()).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(seedHome, '.config')).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(seedHome, '.config', 'gh')).mode & 0o777).toBe(0o700);
  });

  it('works when no seed exists yet (no Claude token present)', () => {
    run(FINE);
    expect(existsSync(hostsFile())).toBe(true);
    expect(existsSync(gitconfigFile())).toBe(true);
  });

  // The cross-preservation invariant: seeding GitHub must not wipe an existing Claude credential.
  it('preserves an existing Claude seed', () => {
    seedClaude();
    run(FINE);
    expect(readFileSync(path.join(seedHome, '.claude', '.credentials.json'), 'utf8')).toBe('{"claude":"cred"}');
    expect(readFileSync(path.join(seedHome, '.claude.json'), 'utf8')).toBe('{"hasCompletedOnboarding":true}');
    expect(existsSync(hostsFile())).toBe(true);
  });

  // …and the reverse: a Claude RE-SEED (the real cred script) must not wipe the GitHub auth. This is
  // the whole reason SEED_HOME_KEEP was centralized + extended.
  it('survives a subsequent Claude re-seed (both auths coexist)', () => {
    run(FINE, ['--user', 'octocat']);
    runCred(CLAUDE_TOKEN);
    expect(existsSync(hostsFile())).toBe(true);
    expect(readFileSync(hostsFile(), 'utf8')).toContain(`oauth_token: ${FINE}`);
    expect(existsSync(gitconfigFile())).toBe(true);
    expect(existsSync(path.join(seedHome, '.claude', '.credentials.json'))).toBe(true);
    // Both auth surfaces coexist. (.claude.json only appears once Claude onboarding writes it, so it's
    // not asserted here — neither seed creates it.)
    const entries = readdirSync(seedHome);
    for (const e of ['.claude', '.config', '.gitconfig']) expect(entries).toContain(e);
  });

  it('rejects a non-PAT value and leaves any existing GitHub seed untouched', () => {
    run(FINE);
    const before = readFileSync(hostsFile(), 'utf8');
    expect(() => run('not-a-token')).toThrow(); // non-zero exit
    expect(readFileSync(hostsFile(), 'utf8')).toBe(before);
  });

  it('keeps .config a template — only gh survives the prune', () => {
    mkdirSync(path.join(seedHome, '.config', 'stray'), { recursive: true });
    run(FINE);
    expect(readdirSync(path.join(seedHome, '.config'))).toEqual(['gh']);
  });

  it('leaves no temp file behind', () => {
    run(FINE);
    expect(readdirSync(path.join(seedHome, '.config', 'gh'))).toEqual(['hosts.yml']);
  });
});

// Direct installGithubSeed tests — the CLI rejects a bad token before installGithubSeed runs, so these
// reach the write path directly (the gap that once let a reverted installer stay green, cred review).
describe('installGithubSeed atomicity', () => {
  let base, seedHome;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'ghatomic-'));
    seedHome = path.join(base, 'home');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('is unaffected by a trailing slash on the seed path', () => {
    installGithubSeed(`${seedHome}${path.sep}`, { token: FINE, user: 'octocat' });
    expect(readFileSync(path.join(seedHome, '.config', 'gh', 'hosts.yml'), 'utf8')).toContain(FINE);
  });

  it('writes both files and prunes to the keep-list', () => {
    mkdirSync(seedHome, { recursive: true });
    writeFileSync(path.join(seedHome, 'stray-state'), 'x'); // not in the keep-list
    installGithubSeed(seedHome, { token: FINE, user: null });
    expect(readdirSync(seedHome).sort()).toEqual(['.config', '.gitconfig']);
  });
});
