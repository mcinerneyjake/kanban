import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// Reads an INSTALLED dependency's package.json, via Node's own resolution rather than a
// hand-joined `<dir>/node_modules/...`. Path-joining looks in exactly one place, while an
// import walks UPWARD — so in a git worktree (nested in the repo, no node_modules of its own)
// the join ENOENTs on the tree vitest is actually running against (tkt-1ea3e3c6eb16).
// Resolving `${dep}/package.json` directly is not an option: the package's `exports` declares
// only ".", so a deep subpath is ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the entry point and
// walk up to the package root instead.
function readInstalled(dep, fromUrl) {
  const entry = createRequire(fromUrl).resolve(dep);
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
      if (pkg.name === dep) return pkg;
    } catch {
      // No package.json here, or unreadable — keep walking.
    }
    if (dirname(dir) === dir) throw new Error(`resolved ${dep} to ${entry} but found no package root above it`);
  }
}

const PKG = read('package.json');
const LOCK = read('package-lock.json');
const DEP = 'ticket-workflow';
const LOCK_KEY = `node_modules/${DEP}`;

describe(`${DEP} git-tag pin`, () => {
  const spec = PKG.dependencies?.[DEP];

  it('is pinned to an immutable version tag, not a branch', () => {
    expect(spec, `${DEP} must be a dependency of this repo`).toBeTruthy();
    expect(spec).toMatch(/^github:mcinerneyjake\/ticket-workflow#v\d+\.\d+\.\d+$/);
  });

  it('resolves to a full commit sha in the lockfile', () => {
    const entry = LOCK.packages?.[LOCK_KEY];
    expect(entry, `${LOCK_KEY} must have a lockfile entry`).toBeTruthy();
    expect(entry.resolved, 'a git dep must resolve to a pinned commit').toMatch(/#[0-9a-f]{40}$/);
  });

  // The one that catches the half-state: CI runs `npm ci`, so the installed tree is
  // whatever `resolved` points at. If that disagrees with the tag, they diverge here.
  it('installs the version its tag names', () => {
    const tag = spec?.match(/#v(\d+\.\d+\.\d+)$/)?.[1];
    expect(tag, `could not parse a version out of "${spec}"`).toBeTruthy();

    // A missing install is "could not check" — it must fail, never skip. Passing here
    // without reading the tree is how a stale resolution stays invisible.
    let installed;
    try {
      installed = readInstalled(DEP, import.meta.url).version;
    } catch (e) {
      throw new Error(
        `Cannot verify the ${DEP} pin: ${DEP} could not be resolved or read (${e.message}). ` +
          `Run npm ci. This is a FAILURE, not a skip — an unverified pin is how a stale git ` +
          `resolution ships silently.`,
        { cause: e },
      );
    }

    expect(
      installed,
      `package.json pins v${tag} but the installed tree is ${installed}. npm did not re-resolve the ` +
        `git dep: delete node_modules/${DEP} and run "npm install github:mcinerneyjake/${DEP}#v${tag}".`,
    ).toBe(tag);
  });

  // tkt-1ea3e3c6eb16 — a worktree is nested INSIDE the repo and carries no node_modules of its
  // own, so every ordinary import resolves upward to the main checkout. A hand-joined
  // `<module dir>/node_modules/...` opts out of that and ENOENTs, failing the whole suite and
  // breaking CLAUDE.md's "the gate runs in a fresh worktree with no install" promise.
  it('reads the package from a nested worktree path with no local node_modules', () => {
    const fromWorktree = pathToFileURL(
      resolve(HERE, '.claude/worktrees/tkt-fresh-no-install/package.audit.test.mjs'),
    );
    expect(readInstalled(DEP, fromWorktree).version).toBe(PKG.dependencies[DEP].match(/#v(.+)$/)[1]);
  });

  // The reason the read is wrapped in a try/catch at all: "could not check" must stay a loud
  // failure. Resolving upward makes the read succeed in more places, which is exactly when a
  // fail-open would go unnoticed — so pin that an unresolvable package still throws.
  it('throws rather than resolving anything when the package is absent', () => {
    expect(() => readInstalled('ticket-workflow-does-not-exist', import.meta.url)).toThrow();
  });

  // The case above never reaches the walk-up loop — `resolve` throws first — so the loop's
  // terminal throw was unpinned, and it is also the loop's only terminator: replacing it with a
  // permissive return left the whole suite green. This reaches it, via a package that resolves
  // but whose package.json name never matches.
  it('throws when the entry resolves but no matching package root exists above it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-noroot-'));
    try {
      const pkgDir = join(dir, 'node_modules', 'ghost-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};');
      // name deliberately disagrees with the directory, so the walk never matches.
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'not-ghost-pkg', main: 'index.js' }));

      expect(() => readInstalled('ghost-pkg', pathToFileURL(join(dir, 'probe.mjs'))))
        .toThrow(/found no package root/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Upward resolution finds the MAIN checkout's copy, which is the documented model: a worktree
  // that bumps the dep must npm install there. This pins that the audit reads the resolved
  // tree's real version, so that disagreement still surfaces instead of being assumed away.
  it('reports the resolved tree\'s own version, not the pin it is compared against', () => {
    const resolved = readInstalled(DEP, import.meta.url);
    expect(resolved.name).toBe(DEP);
    expect(resolved.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
