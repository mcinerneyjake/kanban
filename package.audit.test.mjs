import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// tkt-967f4150774b. `npm install` after retargeting a git-tag pin rewrote only the
// SPEC line and left `resolved` on the old tag's commit — exit 0, "up to date", and
// a tree still on 0.6.0. That half-state commits clean and CI goes green while
// shipping the old package, so the pin is asserted here rather than trusted.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(resolve(HERE, p), 'utf8'));

// Resolves a dependency the way an `import` does, and reports WHICH tree supplied it.
// Path-joining `<dir>/node_modules/...` looks in exactly one place; resolution walks UPWARD,
// which is what lets a git worktree run the gate off the main checkout (tkt-1ea3e3c6eb16).
// Resolving `${dep}/package.json` is unavailable — the package's `exports` declares only "."
// — so resolve the entry and walk up. `owner` is the tree whose node_modules provided it,
// and the caller must check it: auditing a manifest against another tree's install is the
// fail-open this file exists to prevent.
export function resolveInstalled(dep, fromUrl) {
  const entry = createRequire(fromUrl).resolve(dep);
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (e) {
      // Absent is ordinary — keep walking. Present-but-broken is a real fault: a corrupt
      // install must not be walked past and later reported as "no package root".
      if (e.code !== 'ENOENT') throw new Error(`${candidate} is unreadable: ${e.message}`, { cause: e });
      if (dirname(dir) === dir) break;
      continue;
    }
    if (pkg.name === dep) return { pkg, root: dir, owner: dirname(dirname(dir)) };
    if (dirname(dir) === dir) break;
  }
  throw new Error(`resolved ${dep} to ${entry} but found no package root above it`);
}

// The pin spec is parsed in exactly one place so a second, looser copy cannot disagree
// with it or crash on the branch-pin drift this suite exists to name.
const PIN = /^github:mcinerneyjake\/ticket-workflow#v(\d+\.\d+\.\d+)$/;
export const pinnedVersion = (spec) => (typeof spec === 'string' ? spec.match(PIN)?.[1] : undefined) ?? null;

const DEP = 'ticket-workflow';
const LOCK_KEY = `node_modules/${DEP}`;
const PKG = read('package.json');
const LOCK = read('package-lock.json');

// Returns the installed version, or throws loudly. Extracted so the fail-closed paths are
// reachable from a test — inline in an `it`, the catch below survived being mutated into a
// silent skip with the whole suite green.
export function auditPin({ here, pkg, lock, fromUrl, resolver = resolveInstalled }) {
  const spec = pkg.dependencies?.[DEP];
  const tag = pinnedVersion(spec);
  if (!tag) throw new Error(`Cannot verify the ${DEP} pin: "${spec}" is not an immutable version tag.`);

  let found;
  try {
    found = resolver(DEP, fromUrl);
  } catch (e) {
    throw new Error(
      `Cannot verify the ${DEP} pin: it could not be resolved or read (${e.message}). Run npm ci. ` +
        `This is a FAILURE, not a skip — an unverified pin is how a stale git resolution ships silently.`,
      { cause: e },
    );
  }

  // Resolution walks upward, so in a worktree it legitimately lands on the main checkout's
  // node_modules. That is only safe while that tree pins the SAME thing: otherwise we would be
  // auditing this manifest against an install it never produced, and a pin bumped here without
  // an install here would pass on the neighbour's copy.
  if (!samePath(found.owner, here)) {
    const theirSpec = readJsonAt(found.owner, 'package.json')?.dependencies?.[DEP];
    const theirResolved = readJsonAt(found.owner, 'package-lock.json')?.packages?.[LOCK_KEY]?.resolved;
    if (theirSpec !== spec || theirResolved !== lock.packages?.[LOCK_KEY]?.resolved) {
      throw new Error(
        `Cannot verify the ${DEP} pin: ${DEP} resolved from ${found.owner}, whose pin (${theirSpec}) ` +
          `differs from this tree's (${spec}). Run "npm install" HERE — otherwise this checks the ` +
          `neighbouring tree's install, not the one this lockfile describes.`,
      );
    }
  }

  if (found.pkg.version !== tag) {
    throw new Error(
      `package.json pins v${tag} but the installed tree is ${found.pkg.version}. npm did not re-resolve ` +
        `the git dep: delete node_modules/${DEP} and run "npm install github:mcinerneyjake/${DEP}#v${tag}".`,
    );
  }
  return found.pkg.version;
}

function readJsonAt(dir, file) {
  try {
    return JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
  } catch {
    return undefined;
  }
}

// realpath both sides: on macOS the temp dir is /var/... while resolution reports
// /private/var/..., and a string compare would call the same tree foreign.
function samePath(a, b) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}

describe(`${DEP} git-tag pin`, () => {
  const spec = PKG.dependencies?.[DEP];

  it('is pinned to an immutable version tag, not a branch', () => {
    expect(spec, `${DEP} must be a dependency of this repo`).toBeTruthy();
    expect(pinnedVersion(spec), `could not parse a version tag out of "${spec}"`).toBeTruthy();
  });

  it('resolves to a full commit sha in the lockfile', () => {
    const entry = LOCK.packages?.[LOCK_KEY];
    expect(entry, `${LOCK_KEY} must have a lockfile entry`).toBeTruthy();
    expect(entry.resolved, 'a git dep must resolve to a pinned commit').toMatch(/#[0-9a-f]{40}$/);
  });

  // The one that catches the half-state: CI runs `npm ci`, so the installed tree is
  // whatever `resolved` points at. If that disagrees with the tag, they diverge here.
  it('installs the version its tag names', () => {
    expect(auditPin({ here: HERE, pkg: PKG, lock: LOCK, fromUrl: import.meta.url })).toBe(pinnedVersion(spec));
  });

  // tkt-1ea3e3c6eb16. Fixtures are built in a temp tree rather than pointed at a synthetic
  // `.claude/worktrees/` path: the real directory may or may not exist with its own
  // node_modules, and a test whose result depends on ambient filesystem state proves nothing.
  describe('resolution and fail-closed paths', () => {
    let dir;
    const url = (...p) => pathToFileURL(join(dir, ...p));

    // A repo root with node_modules, and a nested "worktree" with none — the real shape.
    function seed({ version = '1.0.0', name = DEP } = {}) {
      const pkgDir = join(dir, 'node_modules', DEP);
      mkdirSync(join(dir, 'nested'), { recursive: true });
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};');
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
      return pkgDir;
    }

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    // The regression itself: from a nested dir with no node_modules, resolution must reach
    // the parent's copy. Asserting the VERSION of a planted install is what makes this fail
    // if `fromUrl` is ignored — the previous form compared against the repo's own copy, which
    // is the same file either way, so it stayed green with the fix removed.
    it('resolves from a nested dir with no node_modules up to the parent tree', () => {
      seed({ version: '9.9.9' });
      const found = resolveInstalled(DEP, url('nested', 'probe.mjs'));
      expect(found.pkg.version).toBe('9.9.9');
      expect(realpathSync(found.owner)).toBe(realpathSync(dir));
    });

    it('throws when the package is absent, naming what could not be resolved', () => {
      expect(() => resolveInstalled(DEP, url('probe.mjs'))).toThrow(/Cannot find module|MODULE_NOT_FOUND/);
    });

    // Reaches the walk-up loop's terminal throw, which is also its only terminator.
    it('throws when the entry resolves but no matching package root exists above it', () => {
      seed({ name: 'not-the-dep' });
      expect(() => resolveInstalled(DEP, url('probe.mjs'))).toThrow(/found no package root/);
    });

    // A corrupt install must be reported, not walked past and misreported as "no package root".
    // Node's resolver rejects the package's OWN broken manifest first ("Invalid package config"),
    // which is equally loud; the walk-up catch covers a broken manifest further up the chain.
    it('throws naming the file when the package\'s own manifest is corrupt', () => {
      const pkgDir = seed();
      writeFileSync(join(pkgDir, 'package.json'), '{ this is not json');
      expect(() => resolveInstalled(DEP, url('probe.mjs')))
        .toThrow(/Invalid package config|is unreadable/);
    });

    // The case above is caught by Node before the walk-up runs, so it left the walk's own
    // corrupt-file guard unpinned — deleting that guard kept the suite green. This reaches it:
    // the entry sits one level below the package root, with a broken manifest in between.
    it('throws rather than walking past a corrupt manifest between entry and package root', () => {
      const pkgDir = seed();
      mkdirSync(join(pkgDir, 'lib'), { recursive: true });
      writeFileSync(join(pkgDir, 'lib', 'index.js'), 'module.exports = {};');
      writeFileSync(join(pkgDir, 'lib', 'package.json'), '{ broken');
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: DEP, version: '1.0.0', main: 'lib/index.js' }));

      expect(() => resolveInstalled(DEP, url('probe.mjs'))).toThrow(/is unreadable/);
    });

    // Finding [0]: resolution walks upward with no repo boundary, so a worktree that bumps its
    // pin without installing would otherwise be audited against the neighbour's node_modules
    // and pass. The two trees must agree before a cross-tree read is trusted.
    it('refuses to audit against another tree whose pin differs', () => {
      seed({ version: '9.9.9' });
      const lock = { packages: { [LOCK_KEY]: { resolved: 'git+ssh://x#' + 'a'.repeat(40) } } };
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [DEP]: 'github:mcinerneyjake/ticket-workflow#v9.9.9' } }));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));

      expect(() => auditPin({
        here: join(dir, 'nested'),
        pkg: { dependencies: { [DEP]: 'github:mcinerneyjake/ticket-workflow#v0.0.1' } },
        lock,
        fromUrl: url('nested', 'probe.mjs'),
      })).toThrow(/Run "npm install" HERE/);
    });

    it('accepts a cross-tree read when both trees pin the same thing', () => {
      seed({ version: '9.9.9' });
      const spec = 'github:mcinerneyjake/ticket-workflow#v9.9.9';
      const lock = { packages: { [LOCK_KEY]: { resolved: 'git+ssh://x#' + 'a'.repeat(40) } } };
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [DEP]: spec } }));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));

      expect(auditPin({
        here: join(dir, 'nested'), pkg: { dependencies: { [DEP]: spec } }, lock,
        fromUrl: url('nested', 'probe.mjs'),
      })).toBe('9.9.9');
    });

    // The file's entire reason for existing: "could not check" must be a loud FAILURE. This was
    // unpinned — the catch survived being mutated into a silent skip with every test green.
    it('turns an unresolvable dependency into a loud failure, never a skip', () => {
      const boom = () => { throw new Error('nope'); };
      expect(() => auditPin({
        here: dir, pkg: PKG, lock: LOCK, fromUrl: url('probe.mjs'), resolver: boom,
      })).toThrow(/FAILURE, not a skip/);
    });

    it('fails when the installed version disagrees with the tag', () => {
      seed({ version: '0.0.1' });
      const spec = 'github:mcinerneyjake/ticket-workflow#v9.9.9';
      expect(() => auditPin({
        here: dir, pkg: { dependencies: { [DEP]: spec } }, lock: { packages: {} }, fromUrl: url('probe.mjs'),
      })).toThrow(/pins v9\.9\.9 but the installed tree is 0\.0\.1/);
    });

    it('fails on a branch pin instead of crashing on a null match', () => {
      expect(() => auditPin({
        here: dir, pkg: { dependencies: { [DEP]: 'github:mcinerneyjake/ticket-workflow#main' } },
        lock: LOCK, fromUrl: url('probe.mjs'),
      })).toThrow(/is not an immutable version tag/);
    });
  });
});
