import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Dependency-compatibility gate (tkt-fd8f0380f70a).
 *
 * Dependabot PR #238 bumps typescript 6.0.3 → 7.0.2, which typescript-eslint does not support. The
 * ticket recorded that as a loud failure ("eslint throws, so no files are linted"). It is not:
 * `onUnsupportedTypeScriptVersion` defaults to 'warn', and 'warn' prints only when a loggerFn was
 * passed or `process.stdout.isTTY` (typescript-estree/parseSettings/warnAboutTSVersion.js). We pass
 * no logger and CI has no TTY, so the real behaviour is SILENT: every file linted by a compiler
 * typescript-eslint disclaims, nothing printed, gate green.
 *
 * eslint.config.js now sets 'error' so that path is loud. This file is the second, independent half:
 * it asserts the versions are compatible AT ALL, so the incompatibility is caught even if eslint's
 * internals change again. Two mechanisms because they fail differently — one is a runtime behaviour
 * flag, this is a fact about what is installed.
 */

/** typescript-eslint's OWN declared range — read from the package, never transcribed. */
function supportedTypeScriptRange() {
  const pkgPath = require.resolve('typescript-eslint/package.json');
  const peer = JSON.parse(readFileSync(pkgPath, 'utf8')).peerDependencies?.typescript;
  if (typeof peer !== 'string' || !peer.trim()) {
    throw new Error('typescript-eslint declares no typescript peerDependency — cannot check compatibility');
  }
  return peer;
}

/**
 * Is `version` below the exclusive upper bound in a `>=x <y` range?
 *
 * Hand-rolled rather than pulling in semver, which is present only as a TRANSITIVE dep and would be
 * an undeclared reach-through. Deliberately narrow: it understands exactly the `<major.minor.patch`
 * form typescript-eslint publishes, and THROWS on anything else rather than guessing — a range
 * parser that silently returns "compatible" for a shape it does not understand is the fail-open this
 * whole file exists to close. Controlled below.
 */
export function belowUpperBound(version, range) {
  const bound = /<\s*(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!bound) throw new Error(`no exclusive upper bound found in range ${JSON.stringify(range)}`);
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!v) throw new Error(`unparseable version ${JSON.stringify(version)}`);
  const [a, b] = [v, bound].map((m) => Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]));
  return a < b;
}

describe('typescript is a version typescript-eslint supports', () => {
  const range = supportedTypeScriptRange();
  const installed = JSON.parse(readFileSync(require.resolve('typescript/package.json'), 'utf8')).version;

  it(`installed typescript ${installed} is within typescript-eslint's ${range}`, () => {
    // Goes RED the moment PR #238 (or any future TS major) is merged before typescript-eslint
    // supports it — which is the entire point, since the lint gate itself would stay green.
    expect(belowUpperBound(installed, range), `typescript ${installed} is outside typescript-eslint's declared ${range}. ` +
      'Lint would run against a compiler typescript-eslint disclaims. Hold the TypeScript upgrade until ' +
      'typescript-eslint widens its peer range (tkt-fd8f0380f70a).').toBe(true);
  });

  it('the declared range is read from the package, not transcribed here', () => {
    // A hardcoded copy would silently stop tracking the real constraint the day it widens.
    expect(range).toBe(JSON.parse(readFileSync(require.resolve('typescript-eslint/package.json'), 'utf8')).peerDependencies.typescript);
  });

  it('eslint.config.js makes an unsupported version loud rather than silent', () => {
    // Without this the check above is the ONLY signal, and a developer running lint locally in a TTY
    // would see a warning that CI never prints.
    expect(readFileSync(resolve(HERE, 'eslint.config.js'), 'utf8')).toContain("onUnsupportedTypeScriptVersion: 'error'");
  });
});

describe('belowUpperBound — the probe itself', () => {
  const RANGE = '>=4.8.4 <6.1.0';

  it('accepts versions under the bound and rejects versions at or over it', () => {
    for (const v of ['4.8.4', '5.9.2', '6.0.3', '6.0.99']) expect(belowUpperBound(v, RANGE), v).toBe(true);
    for (const v of ['6.1.0', '6.2.0', '7.0.2', '10.0.0']) expect(belowUpperBound(v, RANGE), v).toBe(false);
  });

  it('compares numerically, not lexically — 10.x must not sort below 6.x', () => {
    expect(belowUpperBound('10.0.0', '>=4.0.0 <6.1.0')).toBe(false);
    expect(belowUpperBound('6.0.10', '>=4.0.0 <6.0.9')).toBe(false);
  });

  it('THROWS on a range shape it does not understand, rather than reporting compatible', () => {
    // The fail-open this file exists to close: a parser that returns true for an unrecognised range
    // would report every future dependency as compatible, forever, and look exactly like a pass.
    for (const range of ['^6.0.0', '>=4.8.4', '*', '', '<6.1']) {
      expect(() => belowUpperBound('6.0.3', range), range).toThrow(/no exclusive upper bound/);
    }
    expect(() => belowUpperBound('next', RANGE)).toThrow(/unparseable version/);
  });
});
