#!/usr/bin/env node
/**
 * Kanban's multi-repo layer over the packaged vacuous ratchet (tkt-d88902f60f7c,
 * tkt-05b1630bb53a). The judgment — ceiling, breadth floor, accepted-list double-entry, distinct
 * exit codes — is `compareToBaseline` from ticket-workflow and is tested upstream; what stays
 * here is the CENTRAL-baseline layer that upstream deliberately dropped for repo-local files:
 * one vacuous-baseline.json holding a row per repo, with each row's `path` binding it to a tree
 * so the ratchet cannot sweep one repo and report another's ceiling (resolveRoot).
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweep, compareToBaseline, vacuousExitCode, BREADTH_FLOOR, VACUOUS_EXIT } from 'ticket-workflow';

export { compareToBaseline, BREADTH_FLOOR };
export const EXIT = VACUOUS_EXIT;

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = resolve(HERE, 'vacuous-baseline.json');
export const REPO_ROOT = resolve(HERE, '../..');

export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
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
  // The package owns the kind->code mapping; kanban's extra 'bad-root' kind lands on PROBE_ERROR.
  process.exit(vacuousExitCode(result));
}
