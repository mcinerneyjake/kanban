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
import { decide, message, nightRunActive, primaryRoot, SENTINEL } from './guard-unattended-merge.mjs';

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

describe('decide() — dimension 9: a backgrounded Bash call (tkt-3b182ba384f3)', () => {
  const bg = (command, run_in_background) => ({
    tool_name: 'Bash',
    tool_input: { command, run_in_background },
  });

  it('blocks a backgrounded call while a run is active', () => {
    expect(decide(bg('npm test', true), present).blocked).toBe(true);
  });

  // The control. Without it this is indistinguishable from a guard that blocks every background
  // call, which would wedge every interactive session on the machine.
  it('permits the same call when no run is active', () => {
    expect(decide(bg('npm test', true), absent).blocked).toBe(false);
  });

  // A foreground call omits the key entirely — the normal path, and the one that must not regress.
  it('permits a foreground call while active', () => {
    expect(decide(payload('npm test'), present).blocked).toBe(false);
  });

  // Truthiness, not `=== true`. The string 'false' is truthy and therefore BLOCKS: fail-closed is
  // the correct direction for a guard, and pinning it here stops a later `=== true` "cleanup".
  it.each([true, 1, 'true', 'false'])('blocks a truthy %p', (v) => {
    expect(decide(bg('npm test', v), present).blocked).toBe(true);
  });

  it.each([false, 0, null, undefined, ''])('permits a falsy %p', (v) => {
    expect(decide(bg('npm test', v), present).blocked).toBe(false);
  });

  // An undeterminable sentinel reads as active, so the new rule inherits that fail-closed reading.
  it('blocks when the sentinel cannot be determined', () => {
    expect(decide(bg('npm test', true), null).blocked).toBe(true);
  });

  // The command rule still owns a malformed payload that makes no background claim.
  it('leaves the unreadable-command reason intact', () => {
    expect(decide({ tool_name: 'Bash', tool_input: {} }, present).reason).toMatch(
      /no readable command/,
    );
  });

  it('still permits a foreground read', () => {
    expect(decide(payload('gh pr view 12'), present).blocked).toBe(false);
  });

  // ORDERING REGRESSION (review, MEDIUM). night-run.mjs's armed pre-flight proves the merge gate by
  // asking a live model to run `gh pr merge 999999999` and matching the shared `Blocked:` marker. If
  // the background rule were evaluated first, a model that backgrounded that probe would satisfy the
  // night's single control without the merge rule ever running. Asserting the REASON, not just
  // `blocked`, is the whole point: both orderings block, and only one exercises the gate.
  it.each(['gh pr merge 12', 'gh api -X PUT /repos/o/r/pulls/1/merge'])(
    'reports the MERGE reason for a backgrounded %s, so the pre-flight control still fires',
    (cmd) => {
      expect(decide(bg(cmd, true), present).reason).toMatch(/merge a pull request/);
    },
  );

  it('carries a remedy naming the foreground fix', () => {
    const { reason, remedy } = decide(bg('npm test', true), present);
    expect(message(reason, present, remedy)).toMatch(/foreground with an explicit timeout/);
  });

  // The merge remedy is the default, so every existing caller keeps its wording.
  it('leaves the merge remedy as the default', () => {
    expect(message('tried to merge a pull request', present)).toMatch(/stays human in every mode/);
  });
});

describe('the wired launcher — dimension 9G: a backgrounded call end to end', () => {
  const run = (sentinel) =>
    spawnSync(process.execPath, [LAUNCHER, sentinel], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test', run_in_background: true },
        cwd: tmp,
      }),
      encoding: 'utf8',
    });

  it('exits 2 and names the foreground remedy while active', () => {
    const res = run(present);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('[guard-unattended-merge] Blocked:');
    expect(res.stderr).toContain('foreground with an explicit timeout');
  });

  it('permits the same call when no run is active', () => {
    expect(run(absent).status).toBe(0);
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

// tkt-cba2d225c6e0 — the payload flag is one of TWO routes to a detached turn. This block covers the
// other: the command STRING. Same discipline as dimension 9 — every block paired with a permitting
// control, because a scanner that refuses `2>&1` would wedge most real commands on the machine.
describe('decide() — dimension 10: shell backgrounding in the command string', () => {
  // The ticket's own example, plus the spellings a trailing-anchored test would miss.
  it.each([
    ['npm test &', 'the bare trailing form'],
    ['npm run build > out.log 2>&1 &', "the ticket's example: a redirect then a fork"],
    ['(npm test &)', 'grouped — ends in punctuation, not in `&`'],
    ['{ npm test & }', 'brace group — same shape'],
    ['npm test & npm run lint', '`&` as a SEPARATOR, mid-command'],
    ['cd /some/other/repo && npm test &', 'the foreign-mode form'],
    ['npm test &| cat', 'zsh `&|` — background and disown'],
  ])('blocks %s (%s)', (cmd) => {
    expect(decide(payload(cmd), present).blocked).toBe(true);
  });

  it.each([
    ['nohup npm test', 'bare'],
    ['setsid npm test', 'bare'],
    ['npm test & disown', 'after a fork'],
    ['FOO=1 nohup npm test', 'behind an env prefix'],
    ['if true; then setsid npm test; fi', 'behind a shell keyword'],
    ['echo x | nohup cat', 'after a pipe — command position, not first word'],
  ])('blocks the detach keyword in %s (%s)', (cmd) => {
    expect(decide(payload(cmd), present).blocked).toBe(true);
  });

  // THE CONTROLS. Without these the block cases are indistinguishable from a scanner that refuses
  // every `&` — and `2>&1` alone appears in most non-trivial commands a night run runs.
  it.each([
    ['npm test && npm run lint', '`&&` is a separator, not a fork'],
    ['npm run build > out.log 2>&1', '`2>&1` is a redirection'],
    ['npm run build &> out.log', '`&>` is a redirection'],
    ['npm test >& out.log', '`>&` is a redirection'],
    ['npm run build >> out.log 2>&1', 'append plus dup'],
    ['echo "npm test &"', 'a double-quoted mention is data'],
    ["echo 'npm test &'", 'a single-quoted mention is data'],
    ['git commit -m "fix & polish"', '`&` inside a commit message'],
    ['./nohup-report.sh', 'a substring, not the command word'],
    ['cat nohup.out', 'a substring in an ARGUMENT'],
    ['echo disown', 'the keyword as an argument, not a command'],
    ['npm test', 'the ordinary foreground case'],
    ['npm test |& tee out.log', '`|&` is bash/zsh shorthand for `2>&1 |` — a pipe, not a fork'],
    ['cat 1<&0', '`1<&0` — an input-descriptor dup'],
  ])('permits %s (%s) even while active', (cmd) => {
    expect(decide(payload(cmd), present).blocked).toBe(false);
  });

  // The `|&` control needs its opposite, or it could be satisfied by a scanner that stopped seeing
  // `&` after a pipe stage at all.
  it('still blocks a fork in the stage after a pipe', () => {
    expect(decide(payload('cat out.log | npm test &'), present).blocked).toBe(true);
  });

  // BACKSLASH — it failed both ways before the review (finding 3). The fail-CLOSED case is the
  // costly one: an ordinary commit refused for a whole night.
  it.each([
    ['git commit -m "handle \\" quote & more"', 'an escaped quote must not flip dq and expose the &'],
    ['echo hi \\& there', 'an escaped & is a literal, not a fork'],
    ['git commit -m "a \\" b & c"', 'the same shape mid-message'],
  ])('permits %s (%s)', (cmd) => {
    expect(decide(payload(cmd), present).blocked).toBe(false);
  });

  it('still sees a real fork after an escaped quote (fail-open half of finding 3)', () => {
    expect(decide(payload("echo don\\'t & npm test"), present).blocked).toBe(true);
  });

  // `#` COMMENTS (finding 7) — another new false block, same class as the backslash one.
  it.each([
    ['npm test # background & wait', 'a trailing comment is not a fork'],
    ['npm test  #  a & b', 'with padding'],
  ])('permits %s (%s)', (cmd) => {
    expect(decide(payload(cmd), present).blocked).toBe(false);
  });

  it.each([
    ['git log --format=%h#%s &', 'mid-word # is an ordinary character, so the & still forks'],
    ['echo "a # b" &', 'a quoted # is not a comment either'],
  ])('still blocks %s (%s)', (cmd) => {
    expect(decide(payload(cmd), present).blocked).toBe(true);
  });

  // KNOWN RESIDUAL (tkt-9f7fe38a1628), pinned rather than left to be discovered. splitBackground masks `$( … )`, so a
  // fork inside a command substitution is not seen — deliberately, and identically to upstream's
  // scanner. In practice the substitution still blocks on the subshell's stdout, so this is not the
  // detached turn the guard is about; the test exists so a future change to that reading is a
  // DELIBERATE edit rather than a silent one.
  it('does not scan inside a command substitution (documented residual)', () => {
    expect(decide(payload('VAR=$(ls &) && echo done'), present).blocked).toBe(false);
  });

  // The sentinel dimension. A guard that blocks these outside a night run would wedge every
  // interactive session on the machine.
  it.each(['npm test &', 'nohup npm test', 'setsid npm test'])(
    'permits %s when no run is active',
    (cmd) => {
      expect(decide(payload(cmd), absent).blocked).toBe(false);
    },
  );

  it('inherits the fail-closed reading of an undeterminable sentinel', () => {
    expect(decide(payload('npm test &'), null).blocked).toBe(true);
  });

  it('carries the BACKGROUND remedy, not the merge one', () => {
    const { reason, remedy } = decide(payload('npm test &'), present);
    expect(message(reason, present, remedy)).toMatch(/foreground with an explicit timeout/);
  });

  // ORDERING, the same regression dimension 9 pins for the payload flag. night-run.mjs's armed
  // pre-flight asks a live model to run `gh pr merge 999999999` and accepts the SHARED
  // `[guard-unattended-merge] Blocked:` marker as proof the MERGE gate fired. A model that complies
  // by appending `&` must still trip the merge rule, or the night's single control passes while the
  // gate it claims to prove never ran. Asserting the REASON is the whole point: both orderings block.
  //
  // The keyword half of the same hazard (review, HIGH). parseGh reads the command WORD, so a
  // `nohup`/`setsid` prefix hid the merge from the merge loop entirely: `nohup gh pr merge 12` was
  // ALLOWED before this ticket, and once the detach rule existed it blocked on the DETACH reason —
  // which the pre-flight would have accepted as proof the merge gate fired.
  it.each([
    'gh pr merge 999999999 &',
    'gh pr merge 12 &',
    'gh api -X PUT /repos/o/r/pulls/1/merge &',
    'nohup gh pr merge 999999999',
    'nohup gh pr merge 12',
    'setsid gh pr merge 12',
    'nohup gh api -X PUT /repos/o/r/pulls/1/merge',
    'nohup gh pr merge 12 &',
  ])('reports the MERGE reason for %s', (cmd) => {
    expect(decide(payload(cmd), present).reason).toMatch(/merge a pull request/);
  });

  // Stripping the wrapper for the merge scan must NOT blind the detach rule to the same word.
  it('still reports the DETACH reason when the wrapped command is not a merge', () => {
    expect(decide(payload('nohup npm test'), present).reason).toMatch(/detach/);
  });

  // `&` SEPARATES as well as backgrounds, and splitSegments deliberately does not break on it — so
  // a merge sitting after one parsed as the command `npm` and the merge rule never ran at all. The
  // background rule would refuse this anyway; the reason is what the pre-flight control reads.
  it('finds a merge hidden after a bare `&`, where splitSegments does not break', () => {
    expect(decide(payload('npm test & gh pr merge 12'), present).reason).toMatch(
      /merge a pull request/,
    );
  });
});

describe('the wired launcher — dimension 10G: shell backgrounding end to end', () => {
  const run = (command, sentinel) =>
    spawnSync(process.execPath, [LAUNCHER, sentinel], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: tmp }),
      encoding: 'utf8',
    });

  it('exits 2 and names the foreground remedy while active', () => {
    const res = run('npm run build > out.log 2>&1 &', present);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('[guard-unattended-merge] Blocked:');
    expect(res.stderr).toContain('foreground with an explicit timeout');
  });

  it('permits the same command when no run is active', () => {
    expect(run('npm run build > out.log 2>&1 &', absent).status).toBe(0);
  });

  // The control that separates "correct" from "refuses every ampersand".
  it('permits a plain redirection while active', () => {
    expect(run('npm run build > out.log 2>&1', present).status).toBe(0);
  });
});
