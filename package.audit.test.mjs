import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tkt-967f4150774b. `npm install` after retargeting a git-tag pin rewrote only the
// SPEC line and left `resolved` on the old tag's commit — exit 0, "up to date", and
// a tree still on 0.6.0. That half-state commits clean and CI goes green while
// shipping the old package, so the pin is asserted here rather than trusted.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(resolve(HERE, p), 'utf8'));

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
      installed = read(`node_modules/${DEP}/package.json`).version;
    } catch (e) {
      throw new Error(
        `Cannot verify the ${DEP} pin: node_modules/${DEP}/package.json is unreadable (${e.message}). ` +
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
});
