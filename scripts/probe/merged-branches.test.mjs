import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyBranches,
  assertInstruments,
  listMergedPrs,
  resolveDefaultBranch,
  listLocalBranches,
  checkRepo,
  formatReport,
  runCli,
  shellQuote,
  EXIT,
  DEFAULT_LIMIT,
} from './merged-branches.mjs';

const CLI = fileURLToPath(new URL('./merged-branches.mjs', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(CLI), '../..');

const mergedMap = (entries) =>
  new Map(entries.map(([name, oids, numbers]) => [name, { oids: new Set(oids), numbers }]));

describe('classifyBranches', () => {
  const merged = mergedMap([
    ['landed', ['aaa'], [10]],
    ['moved', ['bbb'], [11]],
  ]);
  const branches = [
    { name: 'main', tip: 'zzz' },
    { name: 'landed', tip: 'aaa' },
    { name: 'moved', tip: 'ccc' },
    { name: 'orphan', tip: 'ddd' },
  ];
  const result = classifyBranches({ branches, merged, defaultBranch: 'main' });

  it('reports a merged branch still at its merged head as safe', () => {
    expect(result.safe.map((b) => b.name)).toEqual(['landed']);
    expect(result.safe[0].reason).toContain('#10');
  });

  it('never offers the default branch for deletion', () => {
    expect([...result.safe, ...result.review].map((b) => b.name)).not.toContain('main');
  });

  it('holds a branch with no merged PR for review', () => {
    const orphan = result.review.find((b) => b.name === 'orphan');
    expect(orphan.reason).toContain('no merged PR');
  });

  // The correctness guard: a name matching a merged PR does not mean the commits do.
  it('holds a branch whose tip MOVED after its PR merged, rather than calling it safe', () => {
    const moved = result.review.find((b) => b.name === 'moved');
    expect(moved, 'a moved branch must not be silently dropped').toBeTruthy();
    expect(moved.reason).toContain('moved since');
    expect(result.safe.map((b) => b.name)).not.toContain('moved');
  });

  it('does not resolve the default branch by assuming main', () => {
    const r = classifyBranches({
      branches: [{ name: 'develop', tip: 'x' }, { name: 'main', tip: 'y' }],
      merged: new Map(),
      defaultBranch: 'develop',
    });
    // On a develop-default repo, `main` is an ordinary branch and must be judged.
    expect(r.review.map((b) => b.name)).toContain('main');
    expect(r.review.map((b) => b.name)).not.toContain('develop');
  });
});

// A control that cannot fail is decoration. Each case below trips EXACTLY ONE guard and
// asserts that guard's own message — an earlier draft matched a catch-all, so two guards
// could be deleted outright with the suite green (the "a control that PASSES is the
// finding" shape). Every case here was watched to fail with its guard removed.
describe('assertInstruments is a real control', () => {
  // The correct output, which every mutation below deviates from by one field.
  const correct = {
    safe: [{ name: 'landed' }],
    review: [{ name: 'moved' }, { name: 'never-merged' }],
  };
  const like = (over) => () => ({ ...correct, ...over });

  it('passes against the real classifier', () => {
    expect(() => assertInstruments()).not.toThrow();
  });

  it('passes on the correct fixture, so a failure below means the mutation, not the fixture', () => {
    expect(() => assertInstruments(like({}))).not.toThrow();
  });

  it('THROWS naming the POSITIVE guard when a merged unmoved branch is missed', () => {
    expect(() => assertInstruments(like({ safe: [] }))).toThrow(/merged, unmoved branch was not reported safe/);
  });

  it('THROWS naming the MOVED guard when a moved branch is not held for review', () => {
    expect(() => assertInstruments(like({ review: [{ name: 'never-merged' }] }))).toThrow(
      /moved after merge was not held for review/,
    );
  });

  it('THROWS naming the UNMERGED guard when an unmerged branch is not held for review', () => {
    expect(() => assertInstruments(like({ review: [{ name: 'moved' }] }))).toThrow(
      /unmerged branch was not held for review/,
    );
  });

  it('THROWS naming the DEFAULT-BRANCH guard when main is offered for deletion', () => {
    // Exactly one safe entry, so the count guard cannot fire in its place.
    expect(() => assertInstruments(like({ safe: [{ name: 'main' }] }))).toThrow(
      /default branch was offered for deletion/,
    );
  });

  it('THROWS naming the COUNT guard when an extra branch is called safe', () => {
    expect(() => assertInstruments(like({ safe: [{ name: 'landed' }, { name: 'never-merged' }] }))).toThrow(
      /expected exactly 1 safe branch, got 2/,
    );
  });
});

describe('listMergedPrs fails loudly instead of returning a short list', () => {
  const json = (rows) => () => JSON.stringify(rows);
  const pr = (over) => ({ number: 1, headRefName: 'a', headRefOid: 'o1', baseRefName: 'main', ...over });

  it('parses PRs into name -> oids', () => {
    const { byName } = listMergedPrs('/x', 10, json([pr({})]));
    expect(byName.get('a').oids.has('o1')).toBe(true);
  });

  it('collects every oid when one branch name was merged more than once', () => {
    const { byName } = listMergedPrs('/x', 10, json([pr({}), pr({ number: 2, headRefOid: 'o2' })]));
    expect([...byName.get('a').oids].sort()).toEqual(['o1', 'o2']);
  });

  // A PR merged into a feature branch has not landed on the default branch, so its
  // head is not safe to delete. Without this filter, stacked PRs read as landed.
  it('EXCLUDES a PR merged into a non-default base, and says so', () => {
    const { byName, offBase } = listMergedPrs(
      '/x',
      10,
      json([pr({ headRefName: 'child', baseRefName: 'parent-feature' })]),
      'main',
    );
    expect(byName.has('child')).toBe(false);
    expect(offBase).toEqual(['#1 (into parent-feature)']);
  });

  it('keeps a PR merged into the default base', () => {
    const { byName } = listMergedPrs('/x', 10, json([pr({ baseRefName: 'develop' })]), 'develop');
    expect(byName.has('a')).toBe(true);
  });

  // A full page is indistinguishable from a truncated one, and truncation makes
  // merged branches look unmerged.
  it('THROWS when the page comes back exactly full', () => {
    const rows = Array.from({ length: 3 }, (_, i) => pr({ number: i, headRefName: `b${i}` }));
    expect(() => listMergedPrs('/x', 3, json(rows))).toThrow(/may be truncated/);
  });

  it('THROWS when gh itself fails, rather than reporting zero merged PRs', () => {
    const boom = () => {
      throw new Error('gh: command not found');
    };
    expect(() => listMergedPrs('/x', 10, boom)).toThrow(/failure, not an empty result/);
  });

  it('THROWS on unparseable output', () => {
    expect(() => listMergedPrs('/x', 10, () => 'not json')).toThrow(/unparseable JSON/);
  });

  it('THROWS on valid JSON that is not an array, rather than a bare TypeError', () => {
    expect(() => listMergedPrs('/x', 10, () => '{"a":1}')).toThrow(/not an array of PRs/);
  });

  // Field drift: names recorded with no oid can never match a tip, so every branch
  // becomes a fabricated "tip has moved" and the report reads "Safe to delete (0)".
  it('THROWS when not one head oid came back, rather than reporting nothing safe', () => {
    const rows = [pr({ headRefOid: undefined }), pr({ number: 2, headRefName: 'b', headRefOid: undefined })];
    expect(() => listMergedPrs('/x', 10, json(rows))).toThrow(/field \n?drift|field drift/);
  });
});

// Identity comes from -c flags and the branch/refs are set in one `git branch`+plumbing
// pass, because each spawned git costs real wall-clock: an earlier draft made 9 repos and
// pushed several spawnSync tests in OTHER files past vitest's 5s default.
function makeRepo({ remoteDefault = 'main', defaultBranch = 'trunk' } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'mb-'));
  const g = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  g(['init', `--initial-branch=${defaultBranch}`, '-q']);
  writeFileSync(path.join(repo, 'f.txt'), 'x');
  g(['add', 'f.txt']);
  g(['-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-qm', 'init']);
  g(['branch', 'feature-one']);
  const head = g(['rev-parse', 'HEAD']).trim();
  if (remoteDefault) {
    g(['update-ref', `refs/remotes/origin/${remoteDefault}`, head]);
    g(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${remoteDefault}`]);
  }
  return { repo, g, head, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

describe('against real git repositories', () => {
  // `shared` is READ-ONLY: every test below that uses it only reads refs, so sharing is
  // safe. Tests that mutate refs (adding a branch, adding a worktree) build their own —
  // that is the distinction, not a blanket rule either way.
  let shared;
  beforeAll(() => {
    shared = makeRepo();
  });
  afterAll(() => shared.cleanup());

  const mergedAs = (oid, base = 'main') => () =>
    JSON.stringify([{ number: 7, headRefName: 'feature-one', headRefOid: oid, baseRefName: base }]);

  it('lists local branches with their tips', () => {
    const branches = listLocalBranches(shared.repo);
    expect(branches.map((b) => b.name).sort()).toEqual(['feature-one', 'trunk']);
    expect(branches[0].tip).toMatch(/^[0-9a-f]{40}$/);
  });

  // No commit needed: resolveDefaultBranch only reads refs, and `symbolic-ref` does not
  // require its target to exist. Two spawned gits instead of seven.
  it('reads the default branch from origin/HEAD, not from a local name', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'mb-head-'));
    execFileSync('git', ['init', '-q'], { cwd: bare });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'], { cwd: bare });
    expect(resolveDefaultBranch(bare)).toBe('develop');
    rmSync(bare, { recursive: true, force: true });
  });

  // The guess this refuses to make: a local `main` proves nothing about the remote's
  // default, and trusting it can put the real default branch in the delete list.
  it('REFUSES to guess from a local main when the remote says nothing', () => {
    const { repo, g, cleanup } = makeRepo({ remoteDefault: null });
    g(['branch', 'main']);
    expect(() => resolveDefaultBranch(repo)).toThrow(/Refusing to guess/);
    cleanup();
  });

  // Two plausible defaults and nothing saying which: picking the first is a coin flip that
  // can put the real default branch in the delete list. Mutating `=== 1` to a truthy check
  // used to leave the suite green.
  it('REFUSES when both origin/main and origin/master exist and origin/HEAD is unset', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'mb-ambig-'));
    const g = (args) => execFileSync('git', args, { cwd: bare, encoding: 'utf8' });
    g(['init', '-q']);
    writeFileSync(path.join(bare, 'f.txt'), 'x');
    g(['add', 'f.txt']);
    g(['-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-qm', 'i']);
    const head = g(['rev-parse', 'HEAD']).trim();
    g(['update-ref', 'refs/remotes/origin/main', head]);
    g(['update-ref', 'refs/remotes/origin/master', head]);
    expect(() => resolveDefaultBranch(bare)).toThrow(/ambiguous/);
    rmSync(bare, { recursive: true, force: true });
  });

  it('reports a non-repo path as a probe error, never as a clean result', () => {
    const notRepo = mkdtempSync(path.join(tmpdir(), 'mb-bare-'));
    expect(() => checkRepo(notRepo)).toThrow(/git rev-parse/);
    rmSync(notRepo, { recursive: true, force: true });
  });

  it('REFUSES to report when gh finds zero merged PRs but branches exist', () => {
    expect(() => checkRepo(shared.repo, DEFAULT_LIMIT, () => '[]')).toThrow(/ZERO merged PRs/);
  });

  it('drives the whole chain on a real repo with a stubbed gh', () => {
    const result = checkRepo(shared.repo, DEFAULT_LIMIT, mergedAs(shared.head));
    expect(result.safe.map((b) => b.name)).toEqual(['feature-one']);
    expect(result.review.map((b) => b.name)).toContain('trunk');
    expect(formatReport(result.repoPath, result)).toContain("branch -D 'feature-one'");
  });

  // A stacked PR merged into its parent has NOT landed on the default branch.
  it('excludes a branch whose PR merged into a non-default base', () => {
    const result = checkRepo(shared.repo, DEFAULT_LIMIT, mergedAs(shared.head, 'some-parent'));
    expect(result.safe).toHaveLength(0);
    expect(result.offBase).toEqual(['#7 (into some-parent)']);
  });

  // `git -C . branch -D` would retarget whichever repo the reader is standing in.
  it('reports the resolved toplevel, so the delete command is cwd-independent', () => {
    const result = checkRepo(shared.repo, DEFAULT_LIMIT, mergedAs(shared.head));
    expect(result.repoPath).toBe(realpathSync(shared.repo));
    expect(formatReport(result.repoPath, result)).toMatch(/git -C '\/.*' branch -D/);
  });

  // git branch -D refuses a checked-out branch AFTER deleting the others, so one of
  // these in the safe set makes the paste half-apply and exit 1.
  it('holds a branch checked out in a worktree for review, not safe', () => {
    const { repo, head, g, cleanup } = makeRepo();
    const wt = path.join(repo, 'wt');
    g(['worktree', 'add', '-q', wt, 'feature-one']);
    const result = checkRepo(repo, DEFAULT_LIMIT, mergedAs(head));
    expect(result.safe.map((b) => b.name)).not.toContain('feature-one');
    expect(result.review.find((b) => b.name === 'feature-one').reason).toContain('checked out at');
    g(['worktree', 'remove', '--force', wt]);
    cleanup();
  });

  // An inherited GIT_DIR made the probe read one repo and target another, at exit 0.
  it('ignores an ambient GIT_DIR pointing at a different repo', () => {
    const other = makeRepo({ remoteDefault: null });
    other.g(['branch', 'only-in-other']);
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other.repo, '.git');
    try {
      const names = listLocalBranches(shared.repo).map((br) => br.name);
      expect(names, 'branches must come from the repo asked for, not the ambient GIT_DIR').not.toContain(
        'only-in-other',
      );
      expect(names).toContain('feature-one');
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
      other.cleanup();
    }
  });

  it('omits the paste-ready command when nothing is safe', () => {
    const report = formatReport('/r', { safe: [], review: [{ name: 'x', reason: 'y' }], defaultBranch: 'main' });
    expect(report).not.toContain('branch -D');
    expect(report).toContain('(none)');
  });
});

// The one string a human pastes as a destructive command. An earlier draft asserted only
// `toContain('branch -D feature-one')`, which matches the prefix of a line that also names
// review branches — so emitting the review set stayed green.
describe('the paste-ready delete command names the safe set and nothing else', () => {
  const result = {
    defaultBranch: 'main',
    safe: [{ name: 'safe-one', reason: 'merged as #1' }],
    review: [{ name: 'unmerged-keep', reason: 'no merged PR carries this branch name' }],
  };
  const deleteLine = (r) =>
    formatReport('/repo', r)
      .split('\n')
      .find((l) => l.includes('branch -D'));

  it('names every safe branch', () => {
    expect(deleteLine(result)).toContain("'safe-one'");
  });

  it('names NO review branch — the mutation that emitted them used to stay green', () => {
    expect(deleteLine(result)).not.toContain('unmerged-keep');
  });

  it('names exactly as many branches as the safe set has', () => {
    const args = deleteLine(result).split('branch -D ')[1].trim().split(/\s+/);
    expect(args).toHaveLength(result.safe.length);
  });

  // Git permits &, $, (, ) and backticks in a ref name, and a fork PR's head ref is
  // attacker-controlled via `gh pr checkout`.
  it('quotes names so shell metacharacters cannot split or execute on paste', () => {
    const line = deleteLine({
      ...result,
      safe: [{ name: 'feat/a&b', reason: 'r' }, { name: 'v$(id)', reason: 'r' }],
    });
    expect(line).toContain(`'feat/a&b'`);
    expect(line).toContain(`'v$(id)'`);
    expect(line).not.toMatch(/ feat\/a&b/);
  });

  it("escapes an embedded single quote rather than ending the quoted word", () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });
});

describe('CLI', () => {
  const run = (args, cwd = REPO_ROOT) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

  it('exits 2 with no repo path', () => {
    expect(run([]).status).toBe(EXIT.USAGE);
  });

  it('exits 2 on a non-numeric --limit', () => {
    expect(run(['--limit', 'lots', REPO_ROOT]).status).toBe(EXIT.USAGE);
  });

  it('exits 3 — not 0 — on a path that is not a repo', () => {
    const r = run([tmpdir()]);
    expect(r.status).toBe(EXIT.PROBE_ERROR);
    expect(r.status).not.toBe(EXIT.OK);
    expect(r.stderr).toContain('merged-branches:');
  });

  // No CLI case here shells the real `gh`. An earlier version ran `run(['.'])` against
  // this repo and asserted EXIT.OK, which fails wherever gh is unauthenticated — i.e. in
  // CI, reddening the required `gate` for every PR. The absolute-path property it was
  // reaching for is asserted against a temp repo above instead.
  it('accepts --limit=N as well as --limit N', () => {
    expect(run(['--limit=0', REPO_ROOT]).status).toBe(EXIT.USAGE);
    expect(run(['--limit=abc', REPO_ROOT]).status).toBe(EXIT.USAGE);
  });

  // process.exit() does not flush an async stdout pipe, so a long report is truncated
  // mid-branch-name at exit 0 — a short clean-looking result with a success status. Pinned
  // two ways: runCli must RETURN a code (calling process.exit inside it would kill this
  // worker), and the entry point must not reintroduce process.exit. The second is a source
  // assertion because reproducing a >64KB pipe report needs a repo with hundreds of merged
  // branches AND a live gh; the settings.audit / vitest.config audit tests are the
  // precedent for pinning something no behavioural test would catch drifting.
  it('runCli RETURNS an exit code instead of terminating the process', () => {
    expect(runCli([])).toBe(EXIT.USAGE);
    expect(runCli(['--limit', 'abc', REPO_ROOT])).toBe(EXIT.USAGE);
  });

  it('sets process.exitCode at the entry point rather than calling process.exit', () => {
    const src = readFileSync(CLI, 'utf8');
    expect(src).toContain('process.exitCode = runCli(');
    expect(src, 'process.exit() would drop pending stdout writes on a pipe').not.toMatch(/process\.exit\(/);
  });

  it('still runs when invoked through a symlink', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mb-link-'));
    const link = path.join(dir, 'linked.mjs');
    symlinkSync(CLI, link);
    const r = spawnSync(process.execPath, [link], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.status, 'a symlinked CLI must still reach its usage check, not exit 0 silently').toBe(EXIT.USAGE);
    rmSync(dir, { recursive: true, force: true });
  });
});
