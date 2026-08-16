#!/usr/bin/env node
/**
 * Preconditions for the `code-review` CI job (tkt-5f28061cb3bf).
 *
 * The job used to report SUCCESS when `ANTHROPIC_API_KEY` was unset — so "I could not review" and
 * "I reviewed and found nothing" produced the identical green check. This decides instead, and
 * **fails closed**: a missing key exits non-zero rather than skipping quietly.
 *
 * It lives in a script, not inline YAML, so the behaviour is spawnable and testable. Asserting the
 * workflow's *text* would be a substring match on config — the weakness this repo already documents
 * for the settings audit.
 *
 * Usage:  review-preconditions.mjs <changed-file> ...     (or newline-separated on stdin)
 * Exit:   0 decided (writes `significant=<bool>`)   2 cannot review
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Extensions worth spending a review on.
 *
 * `.mjs` and `.yml` are the point of the widening: the previous `.ts|.tsx` filter made the guard
 * hooks, every CI workflow and the deploy pipeline invisible — the code where a defect is most
 * expensive — and made this very workflow exempt from its own review.
 *
 * `.json` is deliberately absent: it would match lockfiles on every dependency bump, and a lockfile
 * diff is both enormous and not meaningfully reviewable by an LLM.
 */
export const REVIEWABLE = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.yml', '.yaml'];

/**
 * Gate files with no reviewable extension. Each one can weaken the build on its own, so a PR editing
 * only these must not read as "nothing to review".
 */
export const REVIEWABLE_PATHS = ['.husky/pre-commit', 'Dockerfile.terminal', 'Dockerfile'];

export const EXIT = { OK: 0, CANNOT_REVIEW: 2 };

export function isReviewable(file) {
  if (REVIEWABLE_PATHS.some((p) => file === p || file.endsWith(`/${p}`))) return true;
  return REVIEWABLE.some((ext) => file.endsWith(ext));
}

/**
 * @returns {{ok: true, significant: boolean, reason: string} | {ok: false, reason: string}}
 */
export function decide(files, env) {
  // `files === null` means the file list could not be READ — distinct from "the PR changed nothing".
  // Collapsing the two is how this script grew its own fail-open: an unreadable stdin returned [],
  // which reads as "nothing to review" → exit 0 → a green check on a review that never happened.
  // Zero files is NOT "nothing to review" — a pull request always changes at least one file, so an
  // empty list means the diff or the pipe failed. It is the same output a genuinely clean PR would
  // produce, which is precisely the ambiguity this script exists to remove; `sweep()` in
  // scripts/probe/vacuous-tests.mjs refuses a zero-file sweep for the identical reason.
  //
  // `null` is the read-threw case. Closing fd 0 does NOT throw — readFileSync(0) returns '' — so the
  // length check below is the one that actually catches a lost stdin, and the null branch is here
  // for genuine EIO. Both land on the same refusal.
  if (files === null || files.length === 0) {
    return {
      ok: false,
      reason:
        'No changed files were readable, so there is no way to tell whether a review is needed. ' +
        'A pull request always changes at least one file, so this means the diff or the pipe ' +
        'failed — not that there was nothing to review.',
    };
  }
  const key = env.ANTHROPIC_API_KEY;
  // Checked BEFORE the file filter on purpose. With the order reversed a docs-only PR would report
  // "nothing to review" and pass green on a repo that cannot review anything at all, which hides the
  // missing key behind whichever diff happens to arrive.
  if (typeof key !== 'string' || key.trim() === '') {
    return {
      ok: false,
      reason:
        'ANTHROPIC_API_KEY is not configured, so no review can run. This check FAILS rather than ' +
        'passing quietly: a green check that reviewed nothing is indistinguishable from a green ' +
        'check that reviewed everything. Set the repo secret, or remove this workflow — do not ' +
        'restore the silent skip.',
    };
  }
  const reviewable = files.filter(isReviewable);
  if (reviewable.length === 0) {
    return {
      ok: true,
      significant: false,
      reason: `Nothing to review: none of the ${files.length} changed file(s) match ${REVIEWABLE.join(', ')}.`,
    };
  }
  return { ok: true, significant: true, reason: `${reviewable.length} reviewable file(s) changed.` };
}

/** @returns {string[] | null} — null means "could not read", never "empty". */
function readFiles(argv) {
  if (argv.length > 0) return argv;
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return null; // EBADF/EIO on stdin — the workflow's only path, so this must not become [].
  }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

/* v8 ignore start -- CLI wiring, exercised by spawning in the test */
function main() {
  const result = decide(readFiles(process.argv.slice(2)), process.env);
  if (!result.ok) {
    console.error(`::error::${result.reason}`);
    process.exit(EXIT.CANNOT_REVIEW);
  }
  // The reason goes to STDERR and only `key=value` to STDOUT: the workflow appends stdout straight
  // into $GITHUB_OUTPUT, where a `::notice::` line is malformed junk rather than an annotation.
  console.error(`::notice::${result.reason}`);
  console.log(`significant=${result.significant}`);
  process.exit(EXIT.OK);
}

// realpath both sides: Node realpaths the entry module, so a symlinked invocation compared by raw
// path makes the CLI a silent no-op (the bug fixed in vacuous-ratchet.mjs).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
/* v8 ignore stop */
