import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
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

// A control that cannot fail is decoration, so the control is driven with a
// deliberately broken classifier and watched to fire.
describe('assertInstruments is a real control', () => {
  it('passes against the real classifier', () => {
    expect(() => assertInstruments()).not.toThrow();
  });

  it('THROWS when the classifier reports nothing safe (the false-clean shape)', () => {
    expect(() => assertInstruments(() => ({ safe: [], review: [] }))).toThrow(/failed its own controls/);
  });

  it('THROWS when the classifier would offer the default branch for deletion', () => {
    expect(() =>
      assertInstruments(() => ({
        safe: [{ name: 'landed' }, { name: 'main' }],
        review: [{ name: 'never-merged' }, { name: 'moved' }],
      })),
    ).toThrow(/default branch was offered for deletion|expected exactly 1 safe/);
  });

  it('THROWS when a branch that moved after merge would be called safe', () => {
    expect(() =>
      assertInstruments(() => ({
        safe: [{ name: 'moved' }],
        review: [{ name: 'never-merged' }],
      })),
    ).toThrow(/failed its own controls/);
  });
});

describe('listMergedPrs fails loudly instead of returning a short list', () => {
  const json = (rows) => () => JSON.stringify(rows);

  it('parses PRs into name -> oids', () => {
    const m = listMergedPrs('/x', 10, json([{ number: 1, headRefName: 'a', headRefOid: 'o1' }]));
    expect(m.get('a').oids.has('o1')).toBe(true);
  });

  it('collects every oid when one branch name was merged more than once', () => {
    const m = listMergedPrs(
      '/x',
      10,
      json([
        { number: 1, headRefName: 'a', headRefOid: 'o1' },
        { number: 2, headRefName: 'a', headRefOid: 'o2' },
      ]),
    );
    expect([...m.get('a').oids].sort()).toEqual(['o1', 'o2']);
  });

  // A full page is indistinguishable from a truncated one, and truncation makes
  // merged branches look unmerged.
  it('THROWS when the page comes back exactly full', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ number: i, headRefName: `b${i}`, headRefOid: 'o' }));
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
});

describe('against real git repositories', () => {
  let repo;
  const g = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'mb-'));
    g(['init', '--initial-branch=trunk', '-q']);
    g(['config', 'user.email', 't@t.t']);
    g(['config', 'user.name', 'T']);
    writeFileSync(path.join(repo, 'f.txt'), 'x');
    g(['add', 'f.txt']);
    g(['commit', '-qm', 'init']);
    g(['branch', 'feature-one']);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('lists local branches with their tips', () => {
    const names = listLocalBranches(repo).map((b) => b.name).sort();
    expect(names).toEqual(['feature-one', 'trunk']);
    expect(listLocalBranches(repo)[0].tip).toMatch(/^[0-9a-f]{40}$/);
  });

  // Never guess `main`: guessing wrong puts the real default branch in the delete list.
  it('REFUSES to guess when origin/HEAD is unset and there is no main or master', () => {
    expect(() => resolveDefaultBranch(repo)).toThrow(/Refusing to guess/);
  });

  it('resolves a main-named default branch when one exists', () => {
    g(['branch', 'main']);
    expect(resolveDefaultBranch(repo)).toBe('main');
    g(['branch', '-D', 'main']);
  });

  it('reports a non-repo path as a probe error, never as a clean result', () => {
    const notRepo = mkdtempSync(path.join(tmpdir(), 'mb-bare-'));
    expect(() => checkRepo(notRepo)).toThrow(/git rev-parse/);
    rmSync(notRepo, { recursive: true, force: true });
  });

  it('REFUSES to report when gh finds zero merged PRs but branches exist', () => {
    g(['branch', 'main']);
    expect(() => checkRepo(repo, DEFAULT_LIMIT, () => '[]')).toThrow(/ZERO merged PRs/);
    g(['branch', '-D', 'main']);
  });

  it('drives the whole chain on a real repo with a stubbed gh', () => {
    g(['branch', 'main']);
    const tip = listLocalBranches(repo).find((b) => b.name === 'feature-one').tip;
    const result = checkRepo(repo, DEFAULT_LIMIT, () =>
      JSON.stringify([{ number: 7, headRefName: 'feature-one', headRefOid: tip }]),
    );
    expect(result.safe.map((b) => b.name)).toEqual(['feature-one']);
    expect(result.review.map((b) => b.name)).toContain('trunk');

    const report = formatReport(repo, result);
    expect(report).toContain('git -C');
    expect(report).toContain('branch -D feature-one');
    g(['branch', '-D', 'main']);
  });

  it('omits the paste-ready command when nothing is safe', () => {
    const report = formatReport('/r', { safe: [], review: [{ name: 'x', reason: 'y' }], defaultBranch: 'main' });
    expect(report).not.toContain('branch -D');
    expect(report).toContain('(none)');
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

  // `git -C .` in a paste-ready delete command would retarget whichever repo the
  // reader is standing in, so the report must carry the resolved toplevel.
  it('emits an absolute path in the delete command, never a relative one', () => {
    const r = run(['.']);
    expect(r.status).toBe(EXIT.OK);
    expect(r.stdout).not.toContain('git -C . branch -D');
    expect(r.stdout).toMatch(/git -C \/.*branch -D/);
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
