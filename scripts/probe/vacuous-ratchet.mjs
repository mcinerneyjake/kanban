#!/usr/bin/env node
/**
 * Ratchet over `vacuous-tests.mjs` (tkt-d88902f60f7c).
 *
 * The probe measures; this decides whether the measurement is acceptable. A
 * count may hold or fall, never rise: a vacuous test is worse than a missing one
 * for agentic work, because it turns the gate green and so reports the work as
 * done.
 *
 * Three things here exist because the first cut got them wrong, and each is the
 * same shape — a check that could not run reporting as a pass:
 *
 *  1. `repo` and `root` were independent, with `root` defaulting to cwd. Naming
 *     one repo while standing in another swept the WRONG TREE and reported the
 *     named repo clean. The row now owns its path and `root` must agree with it.
 *  2. Only the candidate COUNT was read. A sweep that screened 2 of 91 files
 *     scored a clean 0, indistinguishable from a real pass. The recorded
 *     `files`/`blocks` are now a breadth floor, so a collapsed sweep fails.
 *  3. Exit 1 meant both "ceiling breached" and "the probe threw", so a wrapper
 *     could not tell a real finding from a broken instrument. Exit codes are
 *     now distinct: 1 breach, 2 usage, 3 probe error.
 *
 * A MISSING baseline row is likewise a failure, not a pass.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweep } from './vacuous-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = resolve(HERE, 'vacuous-baseline.json');
export const REPO_ROOT = resolve(HERE, '../..');

export const EXIT = { OK: 0, BREACH: 1, USAGE: 2, PROBE_ERROR: 3 };

// A sweep may shrink a little as tests are consolidated; it must not collapse.
// Below this fraction of the recorded breadth, the sweep is treated as not having
// run rather than as a clean result.
export const BREADTH_FLOOR = 0.8;

export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Pure. `found` is the probe's output; `row` the baseline entry (or undefined). */
export function compareToBaseline(repo, found, row) {
  const { candidates = [], files = 0, blocks = 0 } = found;
  const count = candidates.length;

  if (!row || typeof row.max !== 'number') {
    return {
      ok: false,
      kind: 'no-baseline',
      repo,
      found: count,
      max: null,
      message: `No vacuous-test baseline for "${repo}", so ${count} candidate(s) could not be judged. An unknown ceiling is a failure, not a pass — add a row to vacuous-baseline.json.`,
    };
  }

  // Breadth first: a count is only meaningful if the sweep actually looked.
  const floor = Math.floor((row.files ?? 0) * BREADTH_FLOOR);
  if (files < floor) {
    return {
      ok: false,
      kind: 'sweep-collapsed',
      repo,
      found: count,
      max: row.max,
      message: `${repo}: the sweep screened only ${files} test file(s) / ${blocks} block(s), against a recorded ${row.files}/${row.blocks}. Below ${Math.round(BREADTH_FLOOR * 100)}% breadth this is treated as "the probe did not run", not as ${count} candidate(s) — a partial sweep must never pass as clean. Check the root argument and the walk's skip list.`,
    };
  }

  if (count > row.max) {
    return {
      ok: false,
      kind: 'breach',
      repo,
      found: count,
      max: row.max,
      candidates,
      message: `${repo}: ${count} vacuous-test candidate(s), ceiling is ${row.max}. A test that cannot fail turns the gate green and reports the work as done.\n${describe(candidates)}\nFix the new one, or lower the ceiling only if you removed one.`,
    };
  }

  if (count < row.max) {
    return {
      ok: true,
      kind: 'below',
      repo,
      found: count,
      max: row.max,
      message: `${repo}: ${count} candidate(s), below the ceiling of ${row.max} — lower "max" to ${count} in vacuous-baseline.json to keep the ratchet tight.`,
    };
  }
  return {
    ok: true,
    kind: 'at-ceiling',
    repo,
    found: count,
    max: row.max,
    message: `${repo}: ${count}/${row.max} (${files} files, ${blocks} blocks)`,
  };
}

// A count with no location forces a manual re-run to find the offender.
function describe(candidates) {
  return candidates
    .slice(0, 20)
    .map((c) => {
      // The probe already emits a path relative to the swept root; re-relativising
      // it against this repo would mangle another repo's paths.
      const hits = Array.isArray(c.hits) ? c.hits.join('; ') : String(c.hits ?? '');
      return `  ${c.file ?? '(unknown file)'}${c.line ? `:${c.line}` : ''} — ${c.title ?? ''} [${hits}]`;
    })
    .join('\n');
}

/**
 * Resolve which tree a baseline row refers to. The row owns its path so the
 * repo name and the swept tree cannot disagree; `root` may be passed only to
 * confirm it, never to redirect the sweep somewhere the row does not describe.
 */
export function resolveRoot(repo, row, override) {
  const declared = row?.path ? resolve(REPO_ROOT, row.path) : null;
  if (!override) {
    if (!declared) {
      return {
        error: `Baseline row "${repo}" has no "path", so there is no tree to sweep. Add one (relative to the kanban repo root) or pass an explicit root.`,
      };
    }
    return { root: declared };
  }
  const given = resolve(override);
  if (declared && real(given) !== real(declared)) {
    return {
      error: `Refusing to sweep: root "${given}" is not the tree baseline row "${repo}" describes ("${declared}"). Sweeping one repo and reporting another's ceiling is how this check silently passed on a tree it never opened.`,
    };
  }
  // No declared path: at minimum the directory name must match the row name, so
  // `ratchet equipment-schedule .` from kanban cannot report equipment-schedule.
  if (!declared && basename(real(given)) !== repo) {
    return {
      error: `Refusing to sweep: "${given}" does not look like the "${repo}" repo (directory is "${basename(real(given))}"). Pass the repo's own path, or give the baseline row a "path".`,
    };
  }
  return { root: given };
}

export function checkRepo(repo, rootOverride, baseline = loadBaseline()) {
  const row = baseline.repos?.[repo];
  const { root, error } = resolveRoot(repo, row, rootOverride);
  if (error) return { ok: false, kind: 'bad-root', repo, message: error };
  // sweep() runs assertInstruments() first and THROWS on a broken instrument, so
  // a parse failure surfaces as an error rather than a reassuring zero. It is
  // caught here and reported as a probe error, never as a clean pass.
  let found;
  try {
    found = sweep(root);
  } catch (e) {
    return {
      ok: false,
      kind: 'probe-error',
      repo,
      message: `${repo}: the probe itself failed, so nothing was screened — this is NOT a clean result. ${e?.message ?? e}`,
    };
  }
  return compareToBaseline(repo, found, row);
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Compare realpaths: Node realpaths the entry module, so a symlinked invocation
// would otherwise make this whole CLI a silent exit-0 no-op.
function isMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return real(argv1) === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('usage: vacuous-ratchet.mjs <repo-name> [root]   (root must match the baseline row)');
    process.exit(EXIT.USAGE);
  }
  const result = checkRepo(repo, process.argv[3]);
  console.log(result.message);
  if (result.ok) process.exit(EXIT.OK);
  process.exit(result.kind === 'breach' ? EXIT.BREACH : EXIT.PROBE_ERROR);
}
