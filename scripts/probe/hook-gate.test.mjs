import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  ProbeError,
  stripComments,
  stripStrings,
  isHuskyShim,
  coveredScripts,
  readGateScripts,
  readHooksPath,
  resolveHook,
  assertInstruments,
  checkRepo,
  formatReport,
  runCli,
} from './hook-gate.mjs';

// Fixtures inside the repo, never os.tmpdir(): no suite writes outside the workspace.
const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), '.tmp-test');

const HUSKY_SHIM = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
const FULL_GATE = 'npm run typecheck && npm run lint && npm test\n';

let root;

/** A real git repo, because `core.hooksPath` resolution is git's behaviour, not ours. */
function repo({ scripts = ['typecheck', 'lint', 'test'], packageJson = true } = {}) {
  const dir = mkdtempSync(join(root, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (packageJson) {
    const s = Object.fromEntries(scripts.map((n) => [n, `echo ${n}`]));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: s }));
  }
  return dir;
}

function hook(dir, relPath, body, mode = 0o755) {
  const path = join(dir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

const hooksPath = (dir, value) => execFileSync('git', ['config', 'core.hooksPath', value], { cwd: dir });

/**
 * An env that stops git's repo search at the fixture root. Fixtures live inside this repo, so
 * without a ceiling every non-repo fixture resolves to this repo itself and the "not a repo" path is
 * unreachable — the error case would be asserted by a test that never enters it.
 *
 * It has to go through the `env` bag rather than `process.env`, because the probe scrubs and passes
 * the bag it is given to git; a value left only on `process.env` would be dropped.
 */
const outsideAnyRepo = () => ({ PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: root });

/** husky's real layout: hooksPath at `.husky/_`, a shim there, the user script one level up. */
function huskyRepo(userScript = FULL_GATE, { absolute = false, withUserScript = true } = {}) {
  const dir = repo();
  hooksPath(dir, absolute ? join(dir, '.husky', '_') : '.husky/_');
  hook(dir, '.husky/_/pre-commit', HUSKY_SHIM);
  if (withUserScript) hook(dir, '.husky/pre-commit', userScript);
  return dir;
}

beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, 'hook-gate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('coveredScripts — dimension C: what the hook demonstrably runs', () => {
  it('finds all three in the shape the fleet actually uses', () => {
    expect(coveredScripts(FULL_GATE)).toEqual(['typecheck', 'lint', 'test']);
  });

  it('reports exactly a partial hook, never rounding up to the full gate', () => {
    expect(coveredScripts('npm run typecheck\n')).toEqual(['typecheck']);
  });

  it('counts nothing for a hook that runs an unrelated script (equipment-schedule)', () => {
    expect(coveredScripts('node scripts/precommit-semicolons.ts\n')).toEqual([]);
  });

  // The fail-open direction: every hook in this fleet opens with a comment block, and prose in
  // one names scripts it is explaining rather than running.
  it('counts nothing when the only mention is a full-line comment', () => {
    expect(coveredScripts('# npm run typecheck && npm run lint && npm test\nexit 0\n')).toEqual([]);
  });

  it('counts nothing when the only mention is a trailing comment', () => {
    expect(coveredScripts('exit 0 # we deliberately do not npm run test here\n')).toEqual([]);
  });

  // Without the `(?![\w:.-])` guard both of these match, so a hook running neither real script
  // reports both as covered and the session skips a gate nothing ran.
  it('does not accept a prefixed script name as the script', () => {
    expect(coveredScripts('npm run test:e2e && npm run lint:fix && npm run typecheck-only\n')).toEqual([]);
  });

  it('accepts npm\'s `npm test` shorthand as well as `npm run test`', () => {
    expect(coveredScripts('npm test\n')).toEqual(['test']);
    expect(coveredScripts('npm run test\n')).toEqual(['test']);
  });

  it('accepts pnpm and yarn spellings', () => {
    expect(coveredScripts('pnpm run typecheck && yarn run lint\n')).toEqual(['typecheck', 'lint']);
  });

  it('is narrowed by the gate it is given, so a script the repo lacks is never reported', () => {
    expect(coveredScripts(FULL_GATE, ['typecheck'])).toEqual(['typecheck']);
  });

  // Presence is not execution. Each of these names the script and still does not gate the commit.
  it('returns null — undecidable — when a failure could be swallowed', () => {
    expect(coveredScripts('npm run typecheck && npm test || true')).toBeNull();
    expect(coveredScripts('npm test || :')).toBeNull();
  });

  it('returns null when whether the script runs depends on a branch', () => {
    expect(coveredScripts('if [ -n "$CI" ]; then npm test; fi')).toBeNull();
    expect(coveredScripts('for f in a b; do npm run lint; done')).toBeNull();
    expect(coveredScripts('case "$1" in *) npm test ;; esac')).toBeNull();
  });

  // The same prose class the comment strip exists for, wearing quotes instead of a `#`.
  it('counts nothing for a script named only inside a quoted string', () => {
    expect(coveredScripts('echo "gate skipped — run npm test yourself"')).toEqual([]);
    expect(coveredScripts("echo 'remember: npm run lint'")).toEqual([]);
  });

  // The control on that strip: a real command must survive it.
  it('still finds a real command on a line that also carries a quoted string', () => {
    expect(coveredScripts('echo "running the gate" && npm run typecheck')).toEqual(['typecheck']);
  });
});

describe('stripStrings — the strip the quoted-mention case depends on', () => {
  it('empties double- and single-quoted spans', () => {
    expect(stripStrings('echo "npm test" x')).toBe('echo "" x');
    expect(stripStrings("echo 'npm test' x")).toBe('echo "" x');
  });

  it('leaves an escaped quote from ending the span early', () => {
    expect(stripStrings('echo "a \\" npm test" b')).toBe('echo "" b');
  });
});

describe('stripComments — the strip the comment cases depend on', () => {
  it('removes a comment while keeping the command on the same line', () => {
    expect(stripComments('npm test # run it')).toBe('npm test ');
  });

  // `#` only opens a comment at the start of a word; the fleet's hooks use ${var#prefix}.
  it('leaves a mid-word # alone', () => {
    expect(stripComments('echo "${GIT_DIR#refs/}"')).toBe('echo "${GIT_DIR#refs/}"');
  });
});

describe('assertInstruments — a control that fails loud', () => {
  it('passes on the real classifier', () => {
    expect(() => assertInstruments()).not.toThrow();
  });

  // A classifier that claims everything looks exactly like a well-gated repo, and that is the
  // answer that removes the session's gate.
  it('throws when the classifier claims coverage it cannot see', () => {
    expect(() => assertInstruments(() => ['typecheck', 'lint', 'test'])).toThrow(/failed its own controls/);
  });

  it('throws when the classifier claims nothing at all', () => {
    expect(() => assertInstruments(() => [])).toThrow(/failed its own controls/);
  });

  // A classifier that refuses everything is not "safe" — it silently ends the optimisation and
  // looks identical to a fleet with no gating hooks.
  it('throws when the classifier refuses everything', () => {
    expect(() => assertInstruments(() => null)).toThrow(/failed its own controls/);
  });
});

describe('resolveHook — dimensions A and B: which file git would actually run', () => {
  it('A: unset hooksPath resolves to .git/hooks/pre-commit', () => {
    const dir = repo();
    const path = hook(dir, '.git/hooks/pre-commit', FULL_GATE);
    expect(readHooksPath(dir)).toBeNull();
    expect(resolveHook(dir, { env: {} }).hook).toBe(path);
  });

  it('A: a relative hooksPath resolves against the working tree', () => {
    const dir = huskyRepo();
    expect(resolveHook(dir, { env: {} }).hook).toBe(join(dir, '.husky', 'pre-commit'));
  });

  // The measured fail-open: joining an ABSOLUTE hooksPath onto the repo path yields a nonsense
  // path. Both forms are live in this fleet — measured 2026-09-08 with `git config --show-origin
  // --show-scope`, this repo's is absolute in its own `.git/config` while ticket-workflow's is
  // `.husky/_` — and on this repo the join reported a full gate as no hook at all.
  it('A: an absolute hooksPath is used verbatim, not joined onto the repo path', () => {
    const dir = huskyRepo(FULL_GATE, { absolute: true });
    const r = resolveHook(dir, { env: {} });
    expect(r.hook).toBe(join(dir, '.husky', 'pre-commit'));
    expect(coveredScripts(r.text)).toEqual(['typecheck', 'lint', 'test']);
  });

  // Measured: `git hook run pre-commit` in a worktree prints "cannot find a hook named pre-commit".
  // A configured directory that is absent is therefore a determinate "git runs nothing", not an
  // error — and it is the normal state of EVERY worktree, since husky's `.husky/_` self-ignores via
  // `.husky/_/.gitignore` and is never checked out into one.
  it('A: a hooksPath naming a missing directory means git runs no hook, determinately', () => {
    const dir = repo();
    hooksPath(dir, 'no/such/dir');
    const r = resolveHook(dir, { env: {} });
    expect(r.hook).toBeNull();
    expect(r.why).toMatch(/does not exist, so git runs no hook/);
  });

  it('A: a hooksPath directory that exists but cannot be read IS undetermined', () => {
    const dir = repo();
    const hooks = join(dir, 'locked-hooks');
    mkdirSync(hooks, { recursive: true });
    hooksPath(dir, 'locked-hooks');
    chmodSync(hooks, 0o000);
    try {
      expect(() => resolveHook(dir, { env: {} })).toThrow(/exists and cannot be read/);
    } finally {
      chmodSync(hooks, 0o755);
    }
  });

  // The real worktree flow the night run mandates: the commit happens here, and no hook runs.
  it('A: a real worktree reports no hook rather than the primary checkout\'s', () => {
    const dir = huskyRepo();
    // --no-verify: the fixture's shim sources husky's `h`, which this fixture does not ship, so an
    // ordinary commit would be refused by the very hook under test.
    execFileSync('git', ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'seed'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' },
    });
    const wt = join(root, 'wt');
    execFileSync('git', ['worktree', 'add', '--detach', wt], { cwd: dir, stdio: 'ignore' });
    // The generated `_` directory is not tracked, so the worktree has none.
    const r = resolveHook(wt, { env: {} });
    expect(r.hook).toBeNull();
    expect(r.why).toMatch(/does not exist, so git runs no hook/);
    // The control: the SAME repo's primary checkout still reports the full gate.
    expect(coveredScripts(resolveHook(dir, { env: {} }).text)).toEqual(['typecheck', 'lint', 'test']);
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir, stdio: 'ignore' });
  });

  it('B: an unrecognised shim in husky\'s generated directory refuses rather than reporting none', () => {
    const dir = repo();
    hooksPath(dir, '.husky/_');
    hook(dir, '.husky/_/pre-commit', '#!/usr/bin/env sh\n. "$(dirname "$0")/some-new-spelling"\n');
    hook(dir, '.husky/pre-commit', FULL_GATE);
    expect(() => resolveHook(dir, { env: {} })).toThrow(/not a shim spelling this probe knows/);
  });

  // husky sources init.sh BEFORE its own `HUSKY=0` check, so that file can disable every hook
  // without this process's env showing it.
  it('D: a husky init.sh on disk makes coverage undetermined', () => {
    const dir = huskyRepo();
    const home = join(root, 'fakehome');
    mkdirSync(join(home, '.config', 'husky'), { recursive: true });
    writeFileSync(join(home, '.config', 'husky', 'init.sh'), 'export HUSKY=0\n');
    expect(() => resolveHook(dir, { env: { HOME: home } })).toThrow(/can disable every.*hook/s);
    // The control: the same repo with no init.sh resolves normally.
    expect(resolveHook(dir, { env: { HOME: join(root, 'empty-home') } }).hook).toBe(join(dir, '.husky', 'pre-commit'));
  });

  it('B: a non-husky hook is read directly', () => {
    const dir = repo();
    hooksPath(dir, '.husky');
    const path = hook(dir, '.husky/pre-commit', FULL_GATE);
    const r = resolveHook(dir, { env: {} });
    expect(r.hook).toBe(path);
    expect(r.via ?? null).toBeNull();
  });

  // husky's `h` ends `[ ! -f "$s" ] && exit 0`, so a wired hooksPath with no user script runs
  // nothing at all — the file existing is not the gate running.
  it('B: a husky shim with no user script runs nothing', () => {
    const dir = huskyRepo(FULL_GATE, { withUserScript: false });
    const r = resolveHook(dir, { env: {} });
    expect(r.hook).toBeNull();
    expect(r.why).toMatch(/husky exits 0/);
  });

  it('B: no hook at all', () => {
    const r = resolveHook(repo(), { env: {} });
    expect(r.hook).toBeNull();
    expect(r.why).toMatch(/no pre-commit hook/);
  });

  it('B: a hook git would skip for not being executable runs nothing', () => {
    const dir = repo();
    hook(dir, '.git/hooks/pre-commit', FULL_GATE, 0o644);
    const r = resolveHook(dir, { env: {} });
    expect(r.hook).toBeNull();
    expect(r.why).toMatch(/not executable/);
  });

  it('D: HUSKY=0 disables every hook, whatever the file says', () => {
    const dir = huskyRepo();
    const r = resolveHook(dir, { env: { HUSKY: '0' } });
    expect(r.hook).toBeNull();
    expect(r.why).toMatch(/HUSKY=0/);
  });

  it('D: HUSKY set to anything else does not disable the hook', () => {
    const dir = huskyRepo();
    expect(resolveHook(dir, { env: { HUSKY: '1' } }).hook).toBe(join(dir, '.husky', 'pre-commit'));
  });

  it('F: a hook that exists but cannot be read is undetermined, never "runs nothing"', () => {
    const dir = repo();
    const path = hook(dir, '.git/hooks/pre-commit', FULL_GATE, 0o000);
    try {
      expect(() => resolveHook(dir, { env: {} })).toThrow(/could not be read/);
    } finally {
      chmodSync(path, 0o755);
    }
  });

  it('identifies husky\'s shim, and does not mistake an ordinary hook for it', () => {
    expect(isHuskyShim(HUSKY_SHIM)).toBe(true);
    expect(isHuskyShim(FULL_GATE)).toBe(false);
    // A shim quoted inside a comment is prose, not a shim.
    expect(isHuskyShim('# . "$(dirname "$0")/h"\nnpm test\n')).toBe(false);
  });
});

describe('readGateScripts — dimension E: the gate is derived from the target, not assumed', () => {
  it('returns the three when all three exist', () => {
    expect(readGateScripts(repo())).toEqual(['typecheck', 'lint', 'test']);
  });

  it('returns only what exists (rn-playground has typecheck alone)', () => {
    expect(readGateScripts(repo({ scripts: ['typecheck'] }))).toEqual(['typecheck']);
  });

  it('returns nothing for a repo with no package.json (hardpack-consulting)', () => {
    expect(readGateScripts(repo({ packageJson: false }))).toEqual([]);
  });

  it('ignores an empty script value rather than counting the key', () => {
    const dir = repo({ scripts: [] });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: '   ', lint: 'eslint .' } }));
    expect(readGateScripts(dir)).toEqual(['lint']);
  });

  it('throws on an unparseable package.json rather than reporting an empty gate', () => {
    const dir = repo({ packageJson: false });
    writeFileSync(join(dir, 'package.json'), '{ not json');
    expect(() => readGateScripts(dir)).toThrow(/not valid JSON/);
  });
});

describe('checkRepo — the answer the unattended path acts on', () => {
  it('a fully covered repo leaves the session nothing to run', () => {
    const r = checkRepo(huskyRepo(), { env: {} });
    expect(r.covered).toEqual(['typecheck', 'lint', 'test']);
    expect(r.remaining).toEqual([]);
  });

  it('a repo whose hook runs something else leaves the session the whole gate', () => {
    const r = checkRepo(huskyRepo('node scripts/precommit-semicolons.ts\n'), { env: {} });
    expect(r.covered).toEqual([]);
    expect(r.remaining).toEqual(['typecheck', 'lint', 'test']);
  });

  it('a partially covering hook leaves exactly the rest', () => {
    const r = checkRepo(huskyRepo('npm run typecheck && npm run lint\n'), { env: {} });
    expect(r.remaining).toEqual(['test']);
  });

  // `remaining` is the field the caller acts on, so it must never be empty for a reason other
  // than the hook covering the gate.
  it('remaining is empty only because the gate itself is empty, and says so', () => {
    const r = checkRepo(repo({ packageJson: false }), { env: {} });
    expect(r.gate).toEqual([]);
    expect(r.remaining).toEqual([]);
    expect(r.covered).toEqual([]);
  });

  it('refuses, rather than reporting "covers nothing", when the hook shape is undecidable', () => {
    const dir = huskyRepo('npm run typecheck && npm run lint && npm test || true\n');
    expect(() => checkRepo(dir, { env: {} })).toThrow(/undetermined/);
  });

  it('throws rather than answer for a path that is not a git repo', () => {
    const notRepo = mkdtempSync(join(root, 'bare-'));
    expect(() => checkRepo(notRepo, { env: outsideAnyRepo() })).toThrow(ProbeError);
  });

  // Fixtures live inside this repo, so git walks up and finds it. That is git's own resolution and
  // therefore the right answer — the hook it names really is the one a commit there would run —
  // but it is only safe because the report states the RESOLVED toplevel rather than the argument.
  it('a non-repo directory inside a repo reports the enclosing repo, by its resolved path', () => {
    const notRepo = mkdtempSync(join(root, 'inside-'));
    const r = checkRepo(notRepo, { env: {} });
    expect(r.repoPath).not.toBe(notRepo);
    expect(r.repoPath).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: notRepo, encoding: 'utf8',
    }).trim());
  });

  it('reports the resolved toplevel, not the argument', () => {
    const dir = huskyRepo();
    const sub = join(dir, 'src');
    mkdirSync(sub, { recursive: true });
    expect(checkRepo(sub, { env: {} }).repoPath).toBe(checkRepo(dir, { env: {} }).repoPath);
  });
});

describe('formatReport and runCli', () => {
  it('names the covered and the remaining sets separately', () => {
    const text = formatReport(checkRepo(huskyRepo('npm run typecheck\n'), { env: {} }));
    expect(text).toMatch(/covered by the hook: typecheck$/m);
    expect(text).toMatch(/the session must still run: lint, test$/m);
  });

  it('exits 0 and prints a report for a real repo', () => {
    const out = [];
    const code = runCli([huskyRepo()], { env: {}, log: (t) => out.push(t), err: () => {} });
    expect(code).toBe(EXIT.OK);
    expect(out.join('\n')).toMatch(/covered by the hook: typecheck, lint, test/);
  });

  it('--json emits the machine-readable shape', () => {
    const out = [];
    runCli([huskyRepo(), '--json'], { env: {}, log: (t) => out.push(t), err: () => {} });
    expect(JSON.parse(out.join('')).remaining).toEqual([]);
  });

  it('exits USAGE with no argument and with more than one', () => {
    expect(runCli([], { err: () => {} })).toBe(EXIT.USAGE);
    expect(runCli(['a', 'b'], { err: () => {} })).toBe(EXIT.USAGE);
  });

  // A caller must be able to tell a crashed probe from "the hook covers nothing"; the second is
  // merely slow, the first is a reason to stop.
  it('exits PROBE_ERROR, not OK with an empty report, when it cannot determine the answer', () => {
    const errs = [];
    const notRepo = mkdtempSync(join(root, 'bare-'));
    const code = runCli([notRepo], { env: outsideAnyRepo(), log: () => {}, err: (t) => errs.push(t) });
    expect(code).toBe(EXIT.PROBE_ERROR);
    expect(errs.join('\n')).toMatch(/^hook-gate: /);
  });
});
