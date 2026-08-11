#!/usr/bin/env node
/**
 * Ratchet over `vacuous-tests.mjs` (tkt-d88902f60f7c).
 *
 * The probe measures; this decides whether the measurement is acceptable. A
 * count may hold or fall, never rise: a vacuous test is worse than a missing one
 * for agentic work, because it turns the gate green and so reports the work as
 * done.
 *
 * A MISSING baseline row is a failure, not a pass. That is the whole design
 * constraint — "I have no ceiling for this repo" must never read as "this repo
 * is clean", which is the fail-open shape `assertInstruments` exists to prevent
 * one layer down.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweep } from './vacuous-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = resolve(HERE, 'vacuous-baseline.json');

export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Pure. `found` is the probe's candidate count; `row` the baseline entry (or undefined). */
export function compareToBaseline(repo, found, row) {
  if (!row || typeof row.max !== 'number') {
    return {
      ok: false,
      repo,
      found,
      max: null,
      message: `No vacuous-test baseline for "${repo}", so ${found} candidate(s) could not be judged. An unknown ceiling is a failure, not a pass — add a row to vacuous-baseline.json.`,
    };
  }
  if (found > row.max) {
    return {
      ok: false,
      repo,
      found,
      max: row.max,
      message: `${repo}: ${found} vacuous-test candidate(s), ceiling is ${row.max}. A test that cannot fail turns the gate green and reports the work as done. Fix the new one, or lower the ceiling only if you removed one.`,
    };
  }
  // Falling below the ceiling is progress the baseline should capture, or it
  // silently allows the count to climb back.
  if (found < row.max) {
    return {
      ok: true,
      repo,
      found,
      max: row.max,
      message: `${repo}: ${found} candidate(s), below the ceiling of ${row.max} — lower "max" to ${found} in vacuous-baseline.json to keep the ratchet tight.`,
    };
  }
  return { ok: true, repo, found, max: row.max, message: `${repo}: ${found}/${row.max}` };
}

export function checkRepo(repo, root, baseline = loadBaseline()) {
  // sweep() runs assertInstruments() first and THROWS on a broken instrument, so
  // a parse failure surfaces as an error rather than a reassuring zero.
  const { candidates } = sweep(root);
  return compareToBaseline(repo, candidates.length, baseline.repos?.[repo]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = process.argv[2];
  const root = process.argv[3] ?? process.cwd();
  if (!repo) {
    console.error('usage: vacuous-ratchet.mjs <repo-name> [root]');
    process.exit(2);
  }
  const result = checkRepo(repo, root);
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
