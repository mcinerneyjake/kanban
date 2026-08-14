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
    const theirSpec = requireJsonAt(found.owner, 'package.json')?.dependencies?.[DEP];
    // "Declares no such dependency" is not "pins a different version": reported as the latter it
    // printed `pin (undefined) differs` and sent the reader to a lockfile line that does not exist.
    // Reachable via a NESTED install, where `owner` is a package directory rather than a checkout.
    if (typeof theirSpec !== 'string') {
      throw new Error(
        `Cannot verify the ${DEP} pin: ${DEP} resolved from ${found.owner}, whose package.json ` +
          `declares no ${DEP} dependency, so that tree cannot vouch for this install. A nested ` +
          `node_modules/<pkg>/node_modules/${DEP} has this shape — install ${DEP} at the repo root.`,
      );
    }
    if (theirSpec !== spec) {
      throw new Error(
        `Cannot verify the ${DEP} pin: ${DEP} resolved from ${found.owner}, whose pin (${theirSpec}) ` +
          `differs from this tree's (${spec}). Run "npm install" HERE — otherwise this checks the ` +
          `neighbouring tree's install, not the one this lockfile describes.`,
      );
    }
    // tkt-3e63b44f22c5. Checked SEPARATELY from the spec, because agreeing on the spec and
    // disagreeing on the commit is the tkt-967f4150774b half-state, not a pin disagreement: folded
    // into one condition it reported the wrong cause and printed the identical spec twice.
    const theirResolved = requireResolved(requireJsonAt(found.owner, 'package-lock.json'), `${found.owner}'s lockfile`);
    const ourResolved = requireResolved(lock, "this tree's lockfile");
    if (theirResolved !== ourResolved) {
      throw new Error(
        `Cannot verify the ${DEP} pin: both trees pin ${spec}, but ${found.owner} installed ` +
          `${theirResolved} while this lockfile describes ${ourResolved}. Run "npm install" HERE — ` +
          `otherwise this checks the neighbouring tree's install, not the one this lockfile describes.`,
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

// Throws rather than returning `undefined`: swallowing the read collapsed "could not check it" into
// the same value as "it agrees", which is the permissive answer to a question that was never asked.
function requireJsonAt(dir, file) {
  const path = resolve(dir, file);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(
      `Cannot verify the ${DEP} pin: ${DEP} resolved from ${dir}, but ${path} could not be read ` +
        `(${e.message}). This is a FAILURE, not a skip — run "npm install" HERE.`,
      { cause: e },
    );
  }
}

// An absent `resolved` cannot be compared, and must not pass as a comparison: `undefined !==
// undefined` is false, so two trees that both lacked one were read as agreeing (tkt-3e63b44f22c5).
function requireResolved(lock, source) {
  const resolved = lock?.packages?.[LOCK_KEY]?.resolved;
  if (typeof resolved !== 'string' || resolved === '') {
    throw new Error(
      `Cannot verify the ${DEP} pin: ${source} records no "resolved" commit for ${LOCK_KEY}, so the ` +
        `two trees' installs cannot be compared. Run "npm install" HERE.`,
    );
  }
  return resolved;
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

  // The hook launchers in .claude/hooks/ import the package by SUBPATH, which only exists from
  // v0.11.0 — earlier tags throw ERR_PACKAGE_PATH_NOT_EXPORTED, and the launchers fail closed, so
  // every Bash command is blocked. Reverting the pin alone therefore wedges the repo, and the
  // stderr's `npm ci` advice reinstalls the version that cannot be imported. Roll back both or
  // neither (tkt-6e4c55c81208).
  it('pins a version whose hooks are importable by subpath (>= 0.11.0)', () => {
    const [major, minor] = (pinnedVersion(spec) ?? '').split('.').map(Number);
    expect(
      major > 0 || minor >= 11,
      `the .claude/hooks launchers need subpath exports (>= 0.11.0), but the pin is ${pinnedVersion(spec)}`,
    ).toBe(true);
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

    // Distinct shas per side: a fixture that gave both trees the same `resolved` is exactly how the
    // cross-tree lock comparison went untested — it compared a value to itself.
    const SPEC = 'github:mcinerneyjake/ticket-workflow#v9.9.9';
    const OURS = 'git+ssh://x#' + 'a'.repeat(40);
    const THEIRS = 'git+ssh://x#' + 'b'.repeat(40);
    const lockWith = (resolved) => ({ packages: { [LOCK_KEY]: { resolved } } });

    // `null` means "leave the file off disk" — NOT `undefined`, which fires the default parameter and
    // silently writes the agreeing fixture instead, passing a test about an absent file.
    function seedNeighbour({ pkg = { dependencies: { [DEP]: SPEC } }, lock = lockWith(OURS) } = {}) {
      const put = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
      if (pkg !== null) put('package.json', pkg);
      if (lock !== null) put('package-lock.json', lock);
    }

    // Returns the message so the assertion can be about WHICH failure fired, not merely that one did.
    // `toThrow()` alone passes on any throw, including a broken fixture — and the defect under test
    // here is a correct-throw-with-the-wrong-cause, which `toThrow()` cannot see.
    const messageFrom = (fn) => {
      try {
        fn();
      } catch (e) {
        return e.message;
      }
      throw new Error('expected auditPin to throw, but it returned — the guard passed having verified nothing');
    };

    const auditFromNested = (lock) => () => auditPin({
      here: join(dir, 'nested'),
      pkg: { dependencies: { [DEP]: SPEC } },
      lock,
      fromUrl: url('nested', 'probe.mjs'),
    });

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

    // tkt-3e63b44f22c5. The half-state tkt-967f4150774b documents — `npm install` rewrote the SPEC
    // and left `resolved` on the old commit — makes the two trees agree on the spec and disagree on
    // the commit. That is the one shape the lock half of the comparison exists for, and the fixtures
    // above handed both trees the SAME lock object, so it compared a value to itself: deleting the
    // whole `theirResolved` half left 13/13 green.
    it('refuses a cross-tree read when the trees pin one spec but installed different commits', () => {
      seed({ version: '9.9.9' });
      seedNeighbour({ lock: lockWith(THEIRS) });

      const message = messageFrom(auditFromNested(lockWith(OURS)));
      expect(message, 'must name the commit each tree actually installed').toContain('b'.repeat(40));
      expect(message).toContain('a'.repeat(40));
      // The misattribution: same spec both sides, so the pin-mismatch wording printed one value
      // twice — "whose pin (X) differs from this tree's (X)" — sending the reader to the wrong file.
      expect(message, 'the specs AGREE here, so this is not a pin disagreement').not.toMatch(/differs from this tree's/);
    });

    // "Could not read it" must not read as "it agrees". Before the fix both reads collapsed into
    // `undefined`, so an unreadable lockfile fired the PIN-mismatch message instead.
    it('names the neighbour lockfile it could not parse, rather than blaming the pin', () => {
      seed({ version: '9.9.9' });
      seedNeighbour({ lock: '{ this is not json' });

      const message = messageFrom(auditFromNested(lockWith(OURS)));
      expect(message).toContain('package-lock.json');
      // "could not be read" is what distinguishes an unreadable file from the downstream guards,
      // whose messages also name the file — without it this passes on the wrong failure.
      expect(message).toContain('could not be read');
      expect(message).not.toMatch(/differs from this tree's/);
    });

    // ABSENT, not corrupt: a corrupt neighbour manifest is rejected by Node's own resolver before
    // this code runs (the effect at :175-180), so that fixture passed without ever reaching the read
    // it claimed to test — a control that passes is the finding, not a success.
    it('names the neighbour package.json it could not read, rather than blaming the pin', () => {
      seed({ version: '9.9.9' });
      seedNeighbour({ pkg: null });

      const message = messageFrom(auditFromNested(lockWith(OURS)));
      expect(message).toContain('package.json');
      // Same reason as the lockfile case: the declares-no-dependency branch names package.json too,
      // so without this the test passed on that guard instead of on the unreadable-file guard.
      expect(message).toContain('could not be read');
      expect(message).not.toMatch(/differs from this tree's/);
    });

    it('refuses when the neighbour lockfile is readable but carries no entry for the dep', () => {
      seed({ version: '9.9.9' });
      seedNeighbour({ lock: { packages: {} } });

      const message = messageFrom(auditFromNested(lockWith(OURS)));
      expect(message).toContain(LOCK_KEY);
      expect(message).not.toMatch(/differs from this tree's/);
    });

    // The fail-open itself: `undefined !== undefined` is false, so with NEITHER side carrying a
    // `resolved` the comparison passed and the cross-tree install was audited having checked nothing.
    // `messageFrom` throws on a clean return, which is what makes this red before the fix.
    //
    // It asserts WHICH side it blames, not merely that it refused: the neighbour is read first and
    // throws, so this path never evaluates our side. Without that assertion this case is a duplicate
    // of the one above it and the our-side guard below stays unpinned (found in review).
    it('refuses rather than passing when NEITHER tree records a resolved commit', () => {
      seed({ version: '9.9.9' });
      seedNeighbour({ lock: { packages: {} } });

      const message = messageFrom(auditFromNested({ packages: {} }));
      expect(message).toContain('records no "resolved" commit');
      expect(message, 'the neighbour is checked first, so it is the side named').not.toContain("this tree's lockfile");
    });

    // The our-side guard, which the case above cannot reach. Removing it left 18/18 green.
    it('refuses when THIS tree\'s lockfile records no resolved commit', () => {
      seed({ version: '9.9.9' });
      seedNeighbour({ lock: lockWith(OURS) });

      const message = messageFrom(auditFromNested({ packages: {} }));
      expect(message).toContain("this tree's lockfile");
    });

    // Finding 2: the spec half kept the misattribution the lock half just lost. A tree that declares
    // no such dependency is not a tree pinning a different version.
    it('says the neighbour declares no such dependency, rather than calling it a pin mismatch', () => {
      seed({ version: '9.9.9' });
      seedNeighbour({ pkg: { dependencies: {} } });

      const message = messageFrom(auditFromNested(lockWith(OURS)));
      expect(message).toContain('declares no');
      expect(message).not.toMatch(/differs from this tree's/);
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
