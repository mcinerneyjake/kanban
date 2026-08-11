import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareToBaseline,
  loadBaseline,
  checkRepo,
  resolveRoot,
  REPO_ROOT,
  BREADTH_FLOOR,
  EXIT,
} from './vacuous-ratchet.mjs';

const CLI = fileURLToPath(new URL('./vacuous-ratchet.mjs', import.meta.url));
const run = (args, cwd = REPO_ROOT) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

// A row wide enough that the breadth floor is satisfied by the `found` fixtures.
const row = (over = {}) => ({ max: 4, path: '.', files: 10, blocks: 100, ...over });
const found = (n, over = {}) => ({
  candidates: Array.from({ length: n }, (_, i) => ({
    file: `${REPO_ROOT}/src/x${i}.test.ts`,
    line: i + 1,
    title: `case ${i}`,
    hits: ['EMPTY-LOOP'],
  })),
  files: 10,
  blocks: 100,
  ...over,
});

describe('compareToBaseline', () => {
  it('passes when the count equals the ceiling', () => {
    expect(compareToBaseline('r', found(4), row()).ok).toBe(true);
  });

  it('fails when the count rises above the ceiling', () => {
    const r = compareToBaseline('r', found(5), row());
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('breach');
    expect(r.message).toContain('ceiling is 4');
  });

  it('names the offending file and line, not just a count', () => {
    const r = compareToBaseline('r', found(5), row());
    expect(r.message).toContain('src/x0.test.ts:1');
    expect(r.message).toContain('EMPTY-LOOP');
  });

  it('passes but asks for a tighter ceiling when the count falls', () => {
    const r = compareToBaseline('r', found(2), row());
    expect(r.ok).toBe(true);
    expect(r.message).toContain('lower "max" to 2');
  });

  it('FAILS on a missing or malformed baseline row rather than passing', () => {
    for (const bad of [undefined, {}, { max: 'zero' }]) {
      const r = compareToBaseline('unknown-repo', found(3), bad);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('could not be judged');
    }
  });

  it('fails a missing row even when the probe found nothing', () => {
    expect(compareToBaseline('unknown-repo', found(0), undefined).ok).toBe(false);
  });

  // A count is only meaningful if the sweep actually looked.
  it('FAILS a collapsed sweep rather than scoring it clean', () => {
    const r = compareToBaseline('r', found(0, { files: 2, blocks: 9 }), row({ files: 91 }));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('sweep-collapsed');
    expect(r.message).toContain('did not run');
  });

  it('tolerates a small shrink in breadth', () => {
    const files = Math.ceil(10 * BREADTH_FLOOR);
    expect(compareToBaseline('r', found(0, { files }), row({ files: 10 })).ok).toBe(true);
  });
});

// resolveRoot is the fix for the worst defect the review found: sweeping one repo
// and reporting another repo's ceiling.
describe('resolveRoot binds the row to a tree', () => {
  it('uses the row path when no override is given', () => {
    expect(resolveRoot('kanban', { path: '.' }).root).toBe(REPO_ROOT);
  });

  it('REFUSES an override that is not the tree the row describes', () => {
    const r = resolveRoot('equipment-schedule', { path: '../hvac-projects/equipment-schedule' }, REPO_ROOT);
    expect(r.root).toBeUndefined();
    expect(r.error).toContain('Refusing to sweep');
  });

  it('accepts an override that agrees with the row', () => {
    expect(resolveRoot('kanban', { path: '.' }, REPO_ROOT).error).toBeUndefined();
  });

  it('rejects a pathless row with a mismatched directory name', () => {
    expect(resolveRoot('equipment-schedule', { max: 0 }, REPO_ROOT).error).toContain(
      'does not look like',
    );
  });

  it('fails a pathless row with no override rather than defaulting to cwd', () => {
    expect(resolveRoot('somerepo', { max: 0 }).error).toContain('no "path"');
  });
});

describe('vacuous-baseline.json', () => {
  const baseline = loadBaseline();

  it('records every repo swept, with a path binding each row to a tree', () => {
    const repos = Object.entries(baseline.repos);
    // Lower bound, not an exact pin: adding a seventh repo must not fail the gate.
    expect(repos.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(baseline.repos)).toContain('kanban');
    for (const [repo, r] of repos) {
      expect(typeof r.max, repo).toBe('number');
      expect(r.max, repo).toBeGreaterThanOrEqual(0);
      expect(typeof r.path, repo).toBe('string');
      expect(typeof r.files, repo).toBe('number');
    }
  });

  it('carries an asOf date and the floors caveat', () => {
    expect(baseline.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baseline._countsAreFloors).toContain('FLOOR');
  });
});

// The seam the review flagged as untested: sweep() -> compareToBaseline on its
// FAILING path, driven through a real tree rather than hand-built fixtures.
describe('checkRepo end to end against real trees', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ratchet-'));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    // Two clean tests plus one vacuous one, in the shape the probe detects.
    // The clean ones must assert a COMPUTED value against a literal — the probe
    // correctly flags `expect(1).toBe(1)` as LITERAL, which is what a first draft
    // of these fixtures tripped over.
    writeFileSync(
      path.join(dir, 'src/a.test.ts'),
      "import {it,expect} from 'vitest';\nconst n = [1,2,3].length;\nit('ok', () => { expect(n).toBe(3); });\n",
    );
    writeFileSync(
      path.join(dir, 'src/b.test.ts'),
      "import {it,expect} from 'vitest';\nconst m = [1,2].length;\nit('ok too', () => { expect(m).toBe(2); });\n",
    );
    writeFileSync(
      path.join(dir, 'src/vacuous.test.ts'),
      "import {it,expect} from 'vitest';\nit('asserts nothing', () => { const s=[1,2,3]; for (const x of s.filter((n)=>n>99)) { expect(x).toBeGreaterThan(99); } });\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const baselineFor = (over = {}) => ({
    repos: { tmp: { max: 0, path: dir, files: 3, blocks: 3, ...over } },
  });

  it('BREACHES on a real vacuous test, naming it', () => {
    const r = checkRepo('tmp', dir, baselineFor());
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('breach');
    expect(r.found).toBe(1);
    expect(r.message).toContain('vacuous.test.ts');
  });

  it('passes the same tree once the ceiling allows it', () => {
    expect(checkRepo('tmp', dir, baselineFor({ max: 1 })).ok).toBe(true);
  });

  it('reports a probe error as an error, never as clean', () => {
    // A root with no test files makes sweep() throw; that must not read as 0.
    const empty = mkdtempSync(path.join(tmpdir(), 'ratchet-empty-'));
    const r = checkRepo('tmp', empty, { repos: { tmp: { max: 0, path: empty, files: 3 } } });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('probe-error');
    expect(r.message).toContain('NOT a clean result');
    rmSync(empty, { recursive: true, force: true });
  });

  it('refuses a root that disagrees with the row instead of sweeping it', () => {
    const r = checkRepo('tmp', REPO_ROOT, baselineFor());
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('bad-root');
  });
});

describe('CLI', () => {
  it('exits 0 and reports this repo at its ceiling', () => {
    const r = run(['kanban']);
    expect(r.status).toBe(EXIT.OK);
    expect(r.stdout).toContain('kanban: 0/0');
  });

  it('exits 2 on usage error', () => {
    expect(run([]).status).toBe(EXIT.USAGE);
  });

  // Was the worst fail-open: this printed "equipment-schedule: 0 candidates,
  // below the ceiling of 19" while sweeping kanban.
  it('refuses to report another repo while standing in this one', () => {
    const r = run(['equipment-schedule', '.']);
    expect(r.status).not.toBe(EXIT.OK);
    expect(r.stdout + r.stderr).toContain('Refusing to sweep');
  });

  it('distinguishes a probe error from a ceiling breach by exit code', () => {
    const r = run(['kanban', './src/components']);
    expect(r.status).toBe(EXIT.PROBE_ERROR);
    expect(r.status).not.toBe(EXIT.BREACH);
  });

  it('still runs when invoked through a symlink', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ratchet-link-'));
    const link = path.join(dir, 'linked.mjs');
    symlinkSync(CLI, link);
    const r = spawnSync(process.execPath, [link, 'kanban'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.stdout, 'symlinked CLI must still run').toContain('kanban');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('this repo against its own ceiling', () => {
  // The enforcement point. Now covers .claude/ too, so the guard suites that
  // prove commit-to-main is blocked are screened like any other test.
  it('has no more vacuous-test candidates than its baseline allows', () => {
    const result = checkRepo('kanban', undefined);
    expect(result.ok, result.message).toBe(true);
  });

  it('actually screens the .claude guard suites', () => {
    const b = loadBaseline();
    expect(b.repos.kanban.files).toBeGreaterThanOrEqual(90);
  });
});
