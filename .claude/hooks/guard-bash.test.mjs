import { describe, it, expect, vi } from 'vitest';
import { parseGit, cdTarget, decide } from './guard-bash.mjs';

// A branch resolver stub — most cases pin the branch explicitly, ignoring dir.
const onBranch = (name) => () => name;
const blocked = (cmd, branch) => decide(cmd, onBranch(branch)).blocked;

// Two repos, so a command's target actually matters (tkt-74bc8f9b6ba5).
const KANBAN = '/repos/kanban';
const OTHER = '/repos/other';
const byDir = (map) => (dir) => map[dir] ?? null;
const twoRepos = byDir({ [KANBAN]: 'main', [OTHER]: 'feat/x' });

describe('parseGit', () => {
  it('extracts the subcommand and args', () => {
    expect(parseGit('git add -A')).toEqual({ sub: 'add', args: ['-A'], repoDir: null });
    expect(parseGit('git commit -m "x"')).toEqual({ sub: 'commit', args: ['-m', '"x"'], repoDir: null });
  });

  it('captures -C as repoDir, skips -c, skips env prefixes', () => {
    expect(parseGit('git -C /repo add foo')).toEqual({ sub: 'add', args: ['foo'], repoDir: '/repo' });
    expect(parseGit('git -c user.name=x commit')).toEqual({ sub: 'commit', args: [], repoDir: null });
    expect(parseGit('FOO=bar git add foo')).toEqual({ sub: 'add', args: ['foo'], repoDir: null });
  });

  it('requires the command word to be git (not just a mention)', () => {
    expect(parseGit('echo "git add -A"')).toBeNull();
    expect(parseGit('npm test')).toBeNull();
    expect(parseGit('git')).toBeNull();
  });

  it('sees through subshell/group punctuation', () => {
    expect(parseGit('(git add -A)')).toEqual({ sub: 'add', args: ['-A'], repoDir: null });
  });
});

describe('cdTarget', () => {
  it('returns undefined for non-cd segments', () => {
    expect(cdTarget('git commit -m x', KANBAN)).toBeUndefined();
    expect(cdTarget('npm test', KANBAN)).toBeUndefined();
  });

  it('resolves absolute and relative targets', () => {
    expect(cdTarget(`cd ${OTHER}`, KANBAN)).toBe(OTHER);
    expect(cdTarget('cd ../other', KANBAN)).toBe(OTHER);
  });

  it('returns null when resolving would mean guessing', () => {
    expect(cdTarget('cd -', KANBAN)).toBeNull();
    expect(cdTarget('cd', KANBAN)).toBeNull();
    expect(cdTarget('cd $SOMEWHERE', KANBAN)).toBeNull();
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

describe('decide — destructive git flags (blocked on any branch)', () => {
  it('blocks force-push variants', () => {
    expect(blocked('git push --force origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push -f origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push --force-with-lease origin feat/x', 'feat/x')).toBe(true);
  });

  it('blocks git add -f / --force (can stage gitignored secrets)', () => {
    expect(blocked('git add -f .env', 'feat/x')).toBe(true);
    expect(blocked('git add --force dist/bundle.js', 'feat/x')).toBe(true);
  });

  it('blocks git branch -D (force delete) but allows -d', () => {
    expect(blocked('git branch -D feat/x', 'main')).toBe(true);
    expect(blocked('git branch -d feat/x', 'main')).toBe(false);
  });

  it('blocks git reset --hard, git clean -f, git checkout -f', () => {
    expect(blocked('git reset --hard HEAD~1', 'feat/x')).toBe(true);
    expect(blocked('git clean -fd', 'feat/x')).toBe(true);
    expect(blocked('git checkout -f main', 'feat/x')).toBe(true);
  });

  it('still allows the normal workflow shapes', () => {
    expect(blocked('git push -u origin feat/x', 'feat/x')).toBe(false);
    expect(blocked('git add src/App.tsx', 'feat/x')).toBe(false);
    expect(blocked('git checkout -b feat/y', 'main')).toBe(false);
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

describe('decide — hardened bypasses (tkt-0b9b9543907f)', () => {
  it('blocks +refspec force-push (main and feature branches)', () => {
    expect(blocked('git push origin +main', 'feat/x')).toBe(true);
    expect(blocked('git push origin +feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push origin +refs/heads/main', 'feat/x')).toBe(true);
  });

  it('blocks clustered force flags (-uf / -fu)', () => {
    expect(blocked('git push -uf origin feat/x', 'feat/x')).toBe(true);
    expect(blocked('git push -fu origin feat/x', 'feat/x')).toBe(true);
    // a non-force cluster is still fine
    expect(blocked('git push -u origin feat/x', 'feat/x')).toBe(false);
  });

  it('blocks `git push origin HEAD` while on main, allows it on a feature branch', () => {
    expect(blocked('git push origin HEAD', 'main')).toBe(true);
    expect(blocked('git push origin @', 'main')).toBe(true);
    expect(blocked('git push origin HEAD', 'feat/x')).toBe(false);
  });

  it('blocks branch force-delete in all shapes, allows safe -d', () => {
    for (const cmd of ['git branch -D x', 'git branch --delete --force x', 'git branch -d -f x', 'git branch -df x', 'git branch -Df x']) {
      expect(blocked(cmd, 'feat/x'), cmd).toBe(true);
    }
    expect(blocked('git branch -d x', 'feat/x')).toBe(false);
    expect(blocked('git branch --delete x', 'feat/x')).toBe(false);
  });

  it('blocks git clean force via long flag and clusters, allows dry-run', () => {
    for (const cmd of ['git clean --force', 'git clean -f', 'git clean -xdf', 'git clean -ffd']) {
      expect(blocked(cmd, 'feat/x'), cmd).toBe(true);
    }
    expect(blocked('git clean -n', 'feat/x')).toBe(false);
  });

  it('blocks `git switch - && git commit` (previous branch could be main)', () => {
    expect(blocked('git switch - && git commit -m x', 'feat/x')).toBe(true);
    expect(blocked('git checkout - && git commit -m x', 'feat/x')).toBe(true);
    // switching to a named feature branch then committing is still fine
    expect(blocked('git switch feat/y && git commit -m x', 'main')).toBe(false);
  });
});

describe('decide — the command target picks the repo (tkt-74bc8f9b6ba5)', () => {
  // Before this fix, every command was judged against the hook's own cwd, so
  // working in a sibling repo while kanban sat on main blocked every commit.
  it('judges a commit by the repo the chain cd-ed into, not the start dir', () => {
    expect(decide(`cd ${OTHER} && git commit -m x`, twoRepos, KANBAN).blocked).toBe(false);
    expect(decide('git commit -m x', twoRepos, KANBAN).blocked).toBe(true); // kanban is on main
  });

  it('honors git -C without a cd', () => {
    expect(decide(`git -C ${OTHER} commit -m x`, twoRepos, KANBAN).blocked).toBe(false);
    expect(decide(`git -C ${KANBAN} commit -m x`, twoRepos, OTHER).blocked).toBe(true);
  });

  it('resolves a relative cd against startDir', () => {
    expect(decide('cd ../other && git commit -m x', twoRepos, KANBAN).blocked).toBe(false);
  });

  it('keeps branch state per directory — a switch in one repo does not unlock another', () => {
    expect(
      decide(`cd ${OTHER} && git switch -c feat/y && cd ${KANBAN} && git commit -m x`, twoRepos, KANBAN).blocked,
    ).toBe(true);
  });

  it('still blocks a push to main from a sibling repo', () => {
    expect(decide(`cd ${OTHER} && git push origin main`, twoRepos, KANBAN).blocked).toBe(true);
  });

  it('does not block after an unresolvable cd (documented bypass)', () => {
    expect(decide('cd - && git commit -m x', twoRepos, KANBAN).blocked).toBe(false);
  });

  it('resolves each distinct repo once', () => {
    const spy = vi.fn(twoRepos);
    decide(`git status && git log && cd ${OTHER} && git commit -m x && git push origin feat/x`, spy, KANBAN);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([KANBAN, OTHER]);
  });
});

describe('decide — no false positives on quoted / heredoc data', () => {
  it('does not split on && or newlines inside quotes / $( … )', () => {
    // The CLAUDE.md heredoc commit whose body mentions `git add -A` — one command.
    const heredoc = [
      'git commit -m "$(cat <<\'EOF\'',
      'Subject line',
      '',
      'Body that references git add -A and a && chain in prose.',
      'EOF',
      ')"',
    ].join('\n');
    expect(blocked(heredoc, 'feat/x')).toBe(false);
    // A quoted JS string containing `&& git commit` is data, not a command.
    expect(blocked(`node -e 'const s = "git switch - && git commit -m x"'`, 'main')).toBe(false);
  });

  it('still splits and blocks real chained commands', () => {
    expect(blocked('git add server/x.ts && git add -A', 'feat/x')).toBe(true);
    expect(blocked('git switch main && git commit -m x', 'feat/x')).toBe(true);
  });
});
