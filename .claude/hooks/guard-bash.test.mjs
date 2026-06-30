import { describe, it, expect } from 'vitest';
import { parseGit, decide } from './guard-bash.mjs';

// A branch resolver stub — most cases pin the branch explicitly.
const onBranch = (name) => () => name;
const blocked = (cmd, branch) => decide(cmd, onBranch(branch)).blocked;

describe('parseGit', () => {
  it('extracts the subcommand and args', () => {
    expect(parseGit('git add -A')).toEqual({ sub: 'add', args: ['-A'] });
    expect(parseGit('git commit -m "x"')).toEqual({ sub: 'commit', args: ['-m', '"x"'] });
  });

  it('skips global options that take a value (-C / -c) and env prefixes', () => {
    expect(parseGit('git -C /repo add foo')).toEqual({ sub: 'add', args: ['foo'] });
    expect(parseGit('git -c user.name=x commit')).toEqual({ sub: 'commit', args: [] });
    expect(parseGit('FOO=bar git add foo')).toEqual({ sub: 'add', args: ['foo'] });
  });

  it('requires the command word to be git (not just a mention)', () => {
    expect(parseGit('echo "git add -A"')).toBeNull();
    expect(parseGit('npm test')).toBeNull();
    expect(parseGit('git')).toBeNull();
  });

  it('sees through subshell/group punctuation', () => {
    expect(parseGit('(git add -A)')).toEqual({ sub: 'add', args: ['-A'] });
  });
});

describe('decide — whole-tree staging', () => {
  it('blocks -A / --all / . / * / :/ and the stage alias', () => {
    for (const cmd of ['git add -A', 'git add --all', 'git add .', "git add '*'", 'git add :/', 'git stage -A']) {
      expect(blocked(cmd, 'feat/x')).toBe(true);
    }
  });

  it('allows explicit file staging', () => {
    expect(blocked('git add server/index.ts src/App.tsx', 'feat/x')).toBe(false);
    expect(blocked('git add ./server/index.ts', 'feat/x')).toBe(false);
  });
});

describe('decide — commit', () => {
  it('blocks commit -a / -am on any branch (bypasses staging)', () => {
    expect(blocked('git commit -am "x"', 'feat/x')).toBe(true);
    expect(blocked('git commit -a', 'feat/x')).toBe(true);
  });

  it('blocks commit on main, allows a normal commit on a feature branch', () => {
    expect(blocked('git commit -m "x"', 'main')).toBe(true);
    expect(blocked('git commit -m "x"', 'feat/x')).toBe(false);
  });

  it('does not mistake --amend for the -a/--all flag', () => {
    expect(blocked('git commit --amend -m "x"', 'feat/x')).toBe(false);
  });
});

describe('decide — push', () => {
  it('blocks a bare push while on main', () => {
    expect(blocked('git push', 'main')).toBe(true);
    expect(blocked('git push origin', 'main')).toBe(true);
  });

  it('blocks pushes that target main from any branch, including full refspecs', () => {
    expect(blocked('git push -u origin main', 'feat/x')).toBe(true);
    expect(blocked('git push origin HEAD:main', 'feat/x')).toBe(true);
    expect(blocked('git push origin HEAD:refs/heads/main', 'feat/x')).toBe(true);
  });

  it('allows pushing a feature branch', () => {
    expect(blocked('git push -u origin feat/x', 'feat/x')).toBe(false);
  });

  it('allows safe pushes from main (branch deletes, tag pushes)', () => {
    expect(blocked('git push origin --delete feat/old', 'main')).toBe(false);
    expect(blocked('git push --tags', 'main')).toBe(false);
  });
});

describe('decide — compound commands & branch tracking', () => {
  it('trips on a forbidden segment inside a chain', () => {
    expect(blocked('git add . && git commit -m "x"', 'feat/x')).toBe(true);
  });

  it('catches a second command after a newline', () => {
    expect(blocked('git status\ngit push origin main', 'feat/x')).toBe(true);
  });

  it('tracks an in-chain branch switch so branch-then-work is allowed', () => {
    expect(blocked('git switch -c feat/x && git commit -m "x"', 'main')).toBe(false);
    expect(blocked('git switch -c feat/x && git push -u origin feat/x', 'main')).toBe(false);
    expect(blocked('git checkout -b feat/x && git commit -m "x"', 'main')).toBe(false);
  });
});

describe('decide — edge cases', () => {
  it('does not block when the branch is undeterminable', () => {
    expect(decide('git commit -m "x"', () => null).blocked).toBe(false);
    expect(decide('git push', () => null).blocked).toBe(false);
  });

  it('ignores empty / non-string commands', () => {
    expect(blocked('', 'main')).toBe(false);
    expect(decide(undefined, onBranch('main')).blocked).toBe(false);
  });

  it('does not false-positive on data that merely mentions a git command', () => {
    expect(blocked('npm run lint', 'main')).toBe(false);
    expect(blocked('echo "git add -A is documented"', 'feat/x')).toBe(false);
    expect(blocked("printf 'git add -A'", 'feat/x')).toBe(false);
  });
});
