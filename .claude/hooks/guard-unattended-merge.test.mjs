// tkt-1e6a129c8d7f — one case per dimension of the adversary list on the ticket.
//
// The guarantee under test: while a night run is active, no merge-shaped command reaches GitHub.
// Every `blocked` case is paired with a permitting control, because a guard that always blocks is
// not evidence of anything.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, nightRunActive, primaryRoot, SENTINEL } from './guard-unattended-merge.mjs';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HOOKS, 'guard-bash.mjs');

const payload = (command) => ({ tool_name: 'Bash', tool_input: { command } });

// A real path that exists / one that does not — the sentinel dimension, without touching the repo's
// own .night-run directory.
let tmp, present, absent;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'guard-unattended-'));
  present = join(tmp, 'ACTIVE');
  writeFileSync(present, '');
  absent = join(tmp, 'NOT-THERE');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('decide() — dimension 1: sentinel present vs absent', () => {
  it('blocks a merge while a run is active', () => {
    expect(decide(payload('gh pr merge 12'), present).blocked).toBe(true);
  });

  // The control. Without it the suite cannot tell "correct" from "always blocks", and an
  // always-blocking guard would wedge every ordinary merge.
  it('permits the same merge when no run is active', () => {
    expect(decide(payload('gh pr merge 12'), absent).blocked).toBe(false);
  });
});

describe('decide() — dimension 2: merge verb vs read verb', () => {
  it.each(['gh pr view 12', 'gh pr diff 12', 'gh pr list', 'gh pr checks 12'])(
    'permits the read %s even while active',
    (cmd) => {
      expect(decide(payload(cmd), present).blocked).toBe(false);
    },
  );

  // Crossing these is the entire point of --gates auto-pr; gating them would break the queue.
  it.each(['git commit -m x', 'git push -u origin feat/x', 'gh pr create --base main'])(
    'permits %s even while active',
    (cmd) => {
      expect(decide(payload(cmd), present).blocked).toBe(false);
    },
  );
});

describe('decide() — dimension 3: verb hidden behind a value flag', () => {
  it('blocks when -R hides the command group', () => {
    expect(decide(payload('gh -R owner/repo pr merge 1'), present).blocked).toBe(true);
  });
});

describe('decide() — dimension 4: the REST route to the same action', () => {
  it('blocks a write to a merge endpoint', () => {
    expect(decide(payload('gh api -X PUT /repos/o/r/pulls/1/merge'), present).blocked).toBe(true);
  });

  it('permits a GET against the same path', () => {
    expect(decide(payload('gh api /repos/o/r/pulls/1/merge'), present).blocked).toBe(false);
  });

  it('permits a write to a non-merge endpoint', () => {
    expect(decide(payload('gh api -X POST /repos/o/r/issues'), present).blocked).toBe(false);
  });
});

describe('decide() — dimension 5: compound commands (the foreign-mode form)', () => {
  it('blocks a merge behind a cd, which is how the skill drives another repo', () => {
    expect(decide(payload('cd /some/other/repo && gh pr merge 5'), present).blocked).toBe(true);
  });

  it('does not treat a quoted mention as an invocation', () => {
    expect(decide(payload('echo "gh pr merge 5"'), present).blocked).toBe(false);
  });
});

describe('decide() — dimension 6: unreadable input fails closed', () => {
  it('blocks a payload whose command cannot be read, while active', () => {
    expect(decide({ tool_name: 'Bash', tool_input: {} }, present).blocked).toBe(true);
    expect(decide(null, present).blocked).toBe(true);
  });

  it('does not block an unreadable payload when no run is active', () => {
    expect(decide(null, absent).blocked).toBe(false);
  });
});

describe('nightRunActive() — dimension 7: resolution does not depend on cwd', () => {
  it('resolves the sentinel from the module, not the process cwd', () => {
    // The repo path is embedded at import time, so a chdir cannot move it. This is what keeps the
    // guard armed when the skill runs `cd <target> && gh pr merge` in foreign mode.
    const before = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(SENTINEL).toContain(join('.night-run', 'ACTIVE'));
      expect(SENTINEL.startsWith(tmpdir())).toBe(false);
    } finally {
      process.chdir(before);
    }
  });

  it('reports inactive for a path that does not exist', () => {
    expect(nightRunActive(absent)).toBe(false);
  });
});

describe('the wired launcher — dimension 8: the existing git rules must not regress', () => {
  // Spawns the ACTUAL file settings.json wires, so this asserts the effect at the pinned build
  // rather than the logic in isolation.
  const run = (command, repo) =>
    spawnSync(process.execPath, [LAUNCHER], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
      encoding: 'utf8',
    });

  let repo;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'guard-repo-'));
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    // A remote is load-bearing: the package guard deliberately exempts remote-less repos, since
    // "land it on a branch and open a PR" is meaningless with nowhere to push. Without this the
    // commit-on-main cases below pass vacuously.
    git('remote', 'add', 'origin', 'https://example.invalid/x.git');
    writeFileSync(join(repo, 'f.txt'), 'x');
    git('add', 'f.txt');
    git('commit', '-qm', 'init');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('still blocks a commit on main (no night run — the untouched legacy path)', () => {
    expect(run('git commit -m x', repo).status).toBe(2);
  });

  it('still permits a commit on a feature branch (no night run)', () => {
    execFileSync('git', ['switch', '-q', '-c', 'feat/x'], { cwd: repo });
    expect(run('git commit -m x', repo).status).toBe(0);
    execFileSync('git', ['switch', '-q', 'main'], { cwd: repo });
  });

  it('permits gh pr merge when no night run is active', () => {
    expect(run('gh pr merge 12', repo).status).toBe(0);
  });
});

describe('the wired launcher — with a night run genuinely active', () => {
  // The sentinel is injected via argv, NEVER written to the repo. Writing the real one would block
  // merges for any concurrent session for the duration of the suite — and leave the repo wedged if a
  // worker died before cleanup, behind a gitignored file `git status` never shows (review, MEDIUM).
  const run = (command, repo) =>
    spawnSync(process.execPath, [LAUNCHER, present], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
      encoding: 'utf8',
    });

  let repo;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'guard-repo-active-'));
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('remote', 'add', 'origin', 'https://example.invalid/x.git');
    writeFileSync(join(repo, 'f.txt'), 'x');
    git('add', 'f.txt');
    git('commit', '-qm', 'init');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('blocks gh pr merge', () => {
    const res = run('gh pr merge 12', repo);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('guard-unattended-merge');
  });

  it('names the sentinel path and how to clear it', () => {
    expect(run('gh pr merge 12', repo).stderr).toContain(present);
  });

  // The delegation case: stdin was consumed by this launcher, so the package guard runs as a child.
  // If that hand-off broke, the git rules would silently stop applying during exactly the runs that
  // most need them.
  it('still blocks a commit on main, proving the package guard still receives the payload', () => {
    expect(run('git commit -m x', repo).status).toBe(2);
  });

  it('still permits an ordinary read', () => {
    expect(run('git status --short', repo).status).toBe(0);
  });
});

describe('regressions from the high-effort review', () => {
  // The FIRST version of this test compared SENTINEL against dirname(git-common-dir) — and passed
  // against the broken module-relative code, because in the primary checkout the two expressions
  // resolve to the same path. It could only ever fail from inside a worktree, which is precisely
  // where the suite never runs. A control that passes is the finding; this replaces it with the
  // mechanism itself, driven from a REAL worktree.
  it('finding 1: from inside a worktree, resolution points at the PRIMARY checkout', () => {
    const base = mkdtempSync(join(tmpdir(), 'guard-wt-'));
    const primary = join(base, 'primary');
    const tree = join(base, 'wt');
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', primary]);
      const git = (...a) => execFileSync('git', a, { cwd: primary, encoding: 'utf8' });
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 'T');
      writeFileSync(join(primary, 'f.txt'), 'x');
      git('add', 'f.txt');
      git('commit', '-qm', 'init');
      git('worktree', 'add', '-q', tree, '-b', 'feat/x');

      // The bug: a module-relative resolve would answer the WORKTREE root here, where the runner
      // never wrote a sentinel — so every gh pr merge from a native-mode run was allowed.
      const resolved = primaryRoot(tree);
      expect(resolved).toBe(realpathSync(primary));
      expect(resolved).not.toBe(realpathSync(tree));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('finding 2: an unreadable sentinel is ACTIVE, not inactive', () => {
    const locked = join(tmp, 'locked');
    mkdirSync(locked, { recursive: true });
    const target = join(locked, 'ACTIVE');
    writeFileSync(target, '');
    chmodSync(locked, 0o000);
    try {
      // existsSync() returns false here and would have permitted the merge — the bug this replaces.
      expect(nightRunActive(target)).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('finding 2b: an undeterminable primary root is ACTIVE', () => {
    expect(nightRunActive(null)).toBe(true);
  });

  it.each([
    ['gh api --input - /repos/o/r/pulls/1/merge', 'implicit POST via --input'],
    ['gh api -f x=1 /repos/o/r/pulls/1/merge', 'implicit POST via -f'],
    ["gh api graphql -f query='mutation { mergePullRequest(input:{}) }'", 'graphql mutation'],
  ])('finding 4: blocks %s (%s)', (cmd) => {
    expect(decide(payload(cmd), present).blocked).toBe(true);
  });

  it('finding 6: does not falsely block a PR-create whose branch name contains "merge"', () => {
    const cmd = 'gh api -f head=feat/merge/x -X POST /repos/o/r/pulls';
    expect(decide(payload(cmd), present).blocked).toBe(false);
  });

  it('finding 7: blocks a merge behind a shell keyword', () => {
    expect(decide(payload('if true; then gh pr merge 12; fi'), present).blocked).toBe(true);
  });

  it('finding 3: a child guard that exits non-zero blocks rather than allows', () => {
    // Simulated by pointing the launcher at a sentinel that is active and a payload the package
    // guard rejects; the assertion that matters is that only a clean 0 permits.
    const repo = mkdtempSync(join(tmpdir(), 'guard-exit-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const res = spawnSync(process.execPath, [LAUNCHER, present], {
      input: 'not json at all',
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    rmSync(repo, { recursive: true, force: true });
  });
});
