import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countCommits, countActiveDays, countAiCoAuthored, naiveAiCoAuthoredGrep, assertInstruments,
} from './repo-stats.mjs';

// Fixture builder — a throwaway git repo with commits whose Co-authored-by trailers vary in case, so
// the probe's instruments can be proven against a KNOWN answer (the guard-bash.test.mjs precedent).
function git(args, cwd, date) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  return execFileSync('git', args, { cwd, encoding: 'utf8', env });
}
function initRepo(cwd) {
  git(['init', '-q', '-b', 'main'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
  git(['config', 'commit.gpgsign', 'false'], cwd);
}
function commit(cwd, message, date) {
  git(['commit', '--allow-empty', '-q', '-m', message], cwd, date);
}

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// 3 real Claude trailers (mixed key case), 1 human commit, 1 body-mention-only (lowercase, NOT a trailer).
function seedMixedRepo() {
  initRepo(tmp);
  commit(tmp, 'Feature A\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>', '2020-01-01T00:00:00');
  commit(tmp, 'Feature B\n\nco-authored-by: Claude Sonnet <noreply@anthropic.com>', '2020-01-01T00:00:00');
  commit(tmp, 'Feature C\n\nCo-authored-by: Claude Haiku <noreply@anthropic.com>', '2020-01-02T00:00:00');
  commit(tmp, 'Human-only fix', '2020-01-02T00:00:00');
  // The trap: the phrase is mid-body (last paragraph is other text), so it is NOT a trailer.
  commit(tmp, 'Docs\n\nWe follow co-authored-by: claude conventions.\n\nCloses the docs gap.', '2020-01-03T00:00:00');
}

describe('countAiCoAuthored (trailer-aware, case-insensitive)', () => {
  it('positive control: counts every real Claude trailer regardless of key case', () => {
    seedMixedRepo();
    expect(countAiCoAuthored(tmp)).toBe(3);
  });

  it('negative control: excludes the human commit and the body-mention-only commit', () => {
    seedMixedRepo();
    // 5 commits total, only 3 carry a real trailer — proves it is not a body-text grep.
    expect(countCommits(tmp)).toBe(5);
    expect(countAiCoAuthored(tmp)).toBe(3);
  });

  // #4 demonstration: the shipped case-sensitive `--grep` probe UNDERCOUNTS the same fixture — it misses
  // every mixed-case trailer and matches only the lowercase body mention. The remedy, seen going red.
  it('the reconstructed naive probe (#4) undercounts vs the correct instrument', () => {
    seedMixedRepo();
    expect(naiveAiCoAuthoredGrep(tmp)).toBeLessThan(countAiCoAuthored(tmp));
    expect(naiveAiCoAuthoredGrep(tmp)).toBe(1); // only the lowercase body mention
  });
});

describe('countCommits / countActiveDays', () => {
  it('counts commits and distinct authored days', () => {
    seedMixedRepo();
    expect(countCommits(tmp)).toBe(5);
    expect(countActiveDays(tmp)).toBe(3); // 2020-01-01, -02, -03
  });
});

describe('assertInstruments (loud runtime control)', () => {
  it('does not throw when real trailers are present', () => {
    seedMixedRepo();
    expect(() => assertInstruments(tmp)).not.toThrow();
  });

  // The tripwire: "co-authored-by" appears in bodies but the trailer count is 0 — refuse to report the
  // suspicious zero (the #4/#11 shape: a correct-looking method silently reporting absence).
  it('throws when body mentions exist but the trailer count is zero', () => {
    initRepo(tmp);
    commit(tmp, 'Docs\n\nnote about co-authored-by: claude in prose\n\ntail', '2020-01-01T00:00:00');
    expect(countAiCoAuthored(tmp)).toBe(0);
    expect(() => assertInstruments(tmp)).toThrow(/matcher is broken|false zero/i);
  });
});
