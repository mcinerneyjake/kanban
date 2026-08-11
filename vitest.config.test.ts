import { describe, it, expect } from 'vitest';
import config from './vitest.config.js';

// Pins the collection excludes (the .claude/settings.audit.test.mjs precedent: audit the config that
// nothing else would catch drifting). Deleting the worktrees glob only shows up as a red gate on a
// machine that happens to have a worktree — never in CI, which clones fresh (tkt-17d81c74b662).

const exclude = config.test?.exclude ?? [];

describe('vitest collection excludes', () => {
  it('excludes worktree checkouts, this checkout’s e2e specs, and node_modules', () => {
    expect(exclude).toContain('.claude/worktrees/**');
    expect(exclude).toContain('e2e/**');
    expect(exclude).toContain('node_modules/**');
  });

  // `.claude/worktrees/*` would match the worktree dir but not the suites nested inside it, which is
  // the whole point — so the recursive form is the invariant, not merely "some worktrees pattern".
  it('matches recursively, not just the worktree directory', () => {
    const worktreeGlobs = exclude.filter((p) => p.includes('worktrees'));
    expect(worktreeGlobs).not.toHaveLength(0);
    for (const glob of worktreeGlobs) expect(glob.endsWith('/**')).toBe(true);
  });
});

// Eight suites spawn real subprocesses; at vitest's 5s default one of them failed as a
// timeout purely from load elsewhere in the run, which reads as a guard-behaviour failure
// rather than the false negative it is (tkt-0993b12650a1).
describe('subprocess suites get a realistic timeout', () => {
  it('raises testTimeout well above the 5s default', () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(15_000);
  });
});
