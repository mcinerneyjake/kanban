import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A probe for a repo's headline stats (commits / AI-co-authored / active days) that PROVES its own
// instruments before returning a number — so a broken matcher (wrong flag, wrong case, body-vs-trailer)
// fails LOUD instead of returning a plausible-but-false value. tkt-ceebed633013 (see `## Probe discipline`
// in CLAUDE.md): a surprising result is a hypothesis about the instrument, not a finding.

function git(args, cwd) {
  // %B over hundreds of commits is large; lift the default 1MB stdout cap.
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function countCommits(cwd = process.cwd()) {
  return Number.parseInt(git(['rev-list', '--count', 'HEAD'], cwd).trim(), 10);
}

export function countActiveDays(cwd = process.cwd()) {
  const days = git(['log', '--format=%ad', '--date=short'], cwd).split('\n').filter(Boolean);
  return new Set(days).size;
}

// The CORRECT instrument: trailer-aware + case-insensitive. Git parses trailer KEYS case-insensitively
// and only in the trailer block, so this matches `Co-Authored-By`/`co-authored-by` alike AND ignores a
// mid-body mention of the phrase — beating both the case-sensitive `--grep` (#4) and a body-text grep.
// -z NUL-separates commits so a multi-value trailer can't be mistaken for two commits.
export function countAiCoAuthored(cwd = process.cwd()) {
  const out = git(['log', '-z', '--format=%(trailers:key=Co-authored-by,valueonly,separator=%x2C)'], cwd);
  return out.split('\0').filter((record) => /claude/i.test(record)).length;
}

// The DELIBERATELY BROKEN instrument — the reconstructed #4 probe (case-sensitive `--grep`, body text,
// not trailer-aware). Exported ONLY so the test can watch the green check go red; never call it for real.
export function naiveAiCoAuthoredGrep(cwd = process.cwd()) {
  const out = git(['log', '--grep=co-authored-by: claude', '--oneline'], cwd);
  return out.split('\n').filter(Boolean).length;
}

// The loud runtime control: an independent, crude presence signal (raw body mentions) contradicting a
// zero count means the instrument is broken, not the repo empty — the exact #4/#11 shape (a correct-
// looking method silently reporting absence). Refuse to report the false zero.
export function assertInstruments(cwd = process.cwd()) {
  const rawMentions = (git(['log', '--format=%B'], cwd).match(/co-authored-by/gi) ?? []).length;
  const ai = countAiCoAuthored(cwd);
  if (rawMentions > 0 && ai === 0) {
    throw new Error(
      `repo-stats: 0 AI-co-authored commits counted, but ${rawMentions} raw "co-authored-by" mention(s) exist — ` +
      'the matcher is broken (wrong flag/case/format), not the repo. Refusing to report a false zero.',
    );
  }
  const commits = countCommits(cwd);
  if (ai > commits) {
    throw new Error(`repo-stats: aiCoAuthored (${ai}) > commits (${commits}) — impossible; instrument broken.`);
  }
}

export function repoStats(cwd = process.cwd()) {
  assertInstruments(cwd); // controls run BEFORE any value is returned
  return {
    commits: countCommits(cwd),
    aiCoAuthored: countAiCoAuthored(cwd),
    activeDays: countActiveDays(cwd),
    asOf: new Date().toISOString().slice(0, 10),
  };
}

// CLI runner — only when invoked directly (`node scripts/probe/repo-stats.mjs`). Prints JSON for the
// portfolio repoStats refresh; a broken instrument throws here and exits non-zero (loud, not a false 0).
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(repoStats(), null, 2));
}
