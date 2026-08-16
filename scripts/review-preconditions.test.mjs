import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { decide, isReviewable, REVIEWABLE, EXIT } from './review-preconditions.mjs';

const CLI = fileURLToPath(new URL('./review-preconditions.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/code-review.yml', import.meta.url));

/**
 * Spawns the real script, because the defect being fixed was an EXIT CODE, not a return value —
 * asserting `decide()` alone would leave the thing CI actually observes untested.
 */
function run(files, env = {}) {
  // spawnSync, not execFileSync: the latter returns stdout ONLY, so stderr was silently '' on every
  // success and an assertion about the notice text passed against an empty string.
  const r = spawnSync(process.execPath, [CLI, ...files], {
    encoding: 'utf8',
    // A clean env, so a real ANTHROPIC_API_KEY on the developer's machine cannot make the
    // fail-closed case pass vacuously. It is unset here and in CI, which is the whole point.
    env: { PATH: process.env.PATH, ...env },
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('failing closed on a missing key', () => {
  it('EXITS NON-ZERO with no key — the whole bug (tkt-5f28061cb3bf)', () => {
    // The old workflow logged a ::notice:: here and reported SUCCESS, so "could not review" and
    // "reviewed, nothing found" were the same green check on every merged PR.
    const r = run(['src/app.ts']);
    expect(r.code).toBe(EXIT.CANNOT_REVIEW);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY is not configured');
    expect(r.stdout).not.toContain('significant=');
  });

  it('treats an empty or whitespace key as missing, not as configured', () => {
    // A secret set to "" is how this silently comes back: GitHub happily injects an empty string.
    for (const key of ['', '   ']) {
      expect(run(['src/app.ts'], { ANTHROPIC_API_KEY: key }).code).toBe(EXIT.CANNOT_REVIEW);
    }
  });

  it('FAILS on a lost stdin, end to end — not "nothing to review"', () => {
    // The fix shipped its own fail-open: a lost stdin yielded zero files, which read as "nothing
    // changed" → significant=false → exit 0. A green check on a review that never ran, one layer
    // below the bug this ticket exists to remove.
    //
    // Driven through `sh` with fd 0 CLOSED, because that is the only faithful reproduction: Node's
    // readFileSync(0) does NOT throw on a closed descriptor, it returns '' — so a catch-based guard
    // never fires and only the zero-length check catches this.
    const r = spawnSync('sh', ['-c', `ANTHROPIC_API_KEY=sk-ant-test "${process.execPath}" "${CLI}" <&-`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(r.status).toBe(EXIT.CANNOT_REVIEW);
    expect(r.stdout).not.toContain('significant=');
  });

  it('refuses an empty file list from any source, including a genuine read error', () => {
    for (const files of [null, []]) {
      const d = decide(files, { ANTHROPIC_API_KEY: 'sk-ant-test' });
      expect(d.ok).toBe(false);
      expect(d.reason).toContain('always changes at least one file');
    }
  });

  it('checks the key BEFORE the file filter, so a docs-only PR cannot hide it', () => {
    // Reversed, a docs PR would report "nothing to review" and pass green on a repo that cannot
    // review anything at all — the missing key hidden behind whichever diff happened to arrive.
    const r = run(['README.md']);
    expect(r.code).toBe(EXIT.CANNOT_REVIEW);
  });

  it('passes once a key is present — proving the failure is the KEY, not the harness', () => {
    // Without this control, every assertion above would also hold for a script that always exits 2.
    const r = run(['src/app.ts'], { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('significant=true');
  });

  it('writes ONLY key=value to stdout, because the workflow appends it to $GITHUB_OUTPUT', () => {
    // A `::notice::` on stdout lands in the output file as malformed junk rather than rendering as
    // an annotation, so the human-readable reason belongs on stderr.
    const r = run(['README.md'], { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(r.code).toBe(0);
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^[a-z_]+=[^\n]*$/);
    }
    expect(r.stdout).toContain('significant=false');
    expect(r.stderr).toContain('Nothing to review');
  });
});

describe('which files are worth reviewing', () => {
  it('sees .mjs and .yml — the files the old .ts|.tsx filter made invisible', () => {
    // PR #129 changed ONLY guard-bash.mjs + its test, so the security guard hook would not have been
    // reviewed even with a key set. The excluded set was: the guard hooks, every CI workflow, and
    // the deploy pipeline.
    for (const f of ['.claude/hooks/guard-bash.mjs', '.github/workflows/deploy.yml', '.github/workflows/ci.yml']) {
      expect(isReviewable(f), f).toBe(true);
    }
  });

  it('puts code-review.yml in scope of its own filter', () => {
    // It was self-exempting: introduced in a PR touching only .yml and .md, so its own filter skipped
    // it, and it has not been in a diff since. The one moment it was reviewable, it opted out.
    expect(isReviewable('.github/workflows/code-review.yml')).toBe(true);
  });

  it('sees the gate files that carry no reviewable extension', () => {
    // eslint.config.js enforces the TS conventions CLAUDE.md calls "the gate, not just the docs";
    // .husky/pre-commit is the local gate. A PR weakening either read as nothing-to-review.
    for (const f of ['eslint.config.js', '.husky/pre-commit', 'Dockerfile.terminal']) {
      expect(isReviewable(f), f).toBe(true);
    }
  });

  it('still ignores prose and lockfiles', () => {
    for (const f of ['README.md', 'CLAUDE.md', 'package-lock.json', 'src/app.css']) {
      expect(isReviewable(f), f).toBe(false);
    }
  });

  it('reports a docs-only PR as insignificant, with a reason that says so', () => {
    const d = decide(['README.md', 'docs/x.md'], { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(d).toMatchObject({ ok: true, significant: false });
    expect(d.reason).toContain('Nothing to review');
  });

  it('matches on the extension, not a substring anywhere in the path', () => {
    expect(isReviewable('src/ts/notes.md')).toBe(false);
    expect(isReviewable('yaml-notes.txt')).toBe(false);
  });
});

describe('the workflow actually uses this script', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  // Comment lines are stripped before matching. On its first run this suite failed against a comment
  // QUOTING the removed line — the assertion was reading prose, not behaviour. A comment describing
  // the old skip path is documentation; only an executable line is a reintroduction.
  const code = yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('calls it as a SIMPLE command, so its exit status reaches the step', () => {
    // `toContain('node scripts/...')` alone is satisfied by any wrapping. Mutating the call to
    // `… | tee -a "$GITHUB_OUTPUT"` left all 15 tests green while discarding node's exit status —
    // the pipe-swallows-status shape this repo's tenets name, defeating the entire fix.
    const invocations = code.split('\n').filter((l) => l.includes('review-preconditions.mjs'));
    expect(invocations).toHaveLength(1);
    const line = invocations[0].trim();
    expect(line).toMatch(/^node scripts\/review-preconditions\.mjs < changed\.txt >> "\$GITHUB_OUTPUT"$/);
    for (const swallower of ['|', '||', 'set +e', 'continue-on-error', 'true']) {
      expect(line.split(' ').includes(swallower), `"${swallower}" would discard the exit status`).toBe(false);
    }
  });

  it('never sets continue-on-error, which would make a red job report neutral', () => {
    expect(code).not.toContain('continue-on-error');
  });

  it('no longer carries the silent skip path it was fixed for', () => {
    expect(code).not.toContain('secret not configured — skipping code review');
    expect(code).not.toContain("available == 'true'");
    expect(code).not.toMatch(/\[ -f review\.txt \] \|\| exit 0/);
  });

  it('strips comments without gutting the file — the stripper must not match everything', () => {
    // A stripper that returned '' would make every not-toContain above pass vacuously.
    expect(code).toContain('runs-on: ubuntu-latest');
    expect(code.length).toBeGreaterThan(yaml.length / 2);
  });

  it('gates each named review step, so deleting one gate is visible', () => {
    // The previous version quantified over the `if:` lines that HAPPENED to be present, so removing
    // a gate simply removed it from the sample and the suite stayed green. Naming the steps is what
    // makes a deletion fail: mutating away the `Review with Claude` gate now reds this test.
    const steps = new Map();
    for (const block of code.split(/^ {6}- /m).slice(1)) {
      const named = block.match(/^name: (.+)$/m);
      steps.set(named ? named[1].trim() : '<uses>', block);
    }
    for (const name of ['Get PR diff', 'Review with Claude', 'Delete previous review comments', 'Post review comment']) {
      expect([...steps.keys()], `step "${name}" is missing entirely`).toContain(name);
      expect(steps.get(name), `step "${name}" lost its gate`).toContain("if: steps.pre.outputs.significant == 'true'");
    }
  });

  it('skips the job where secrets cannot exist, rather than reddening it pointlessly', () => {
    // Dependabot and fork PRs never receive Actions secrets, so failing closed there is ~5 red
    // checks a week carrying no signal. A skipped job reads as absent, not as passing.
    expect(code).toContain("github.actor != 'dependabot[bot]'");
    expect(code).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });
});

describe('the control set itself', () => {
  it('lists the extensions the ticket requires', () => {
    expect(REVIEWABLE).toEqual(expect.arrayContaining(['.ts', '.tsx', '.mjs', '.yml', '.yaml']));
  });
});
