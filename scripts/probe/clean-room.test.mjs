import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyArm, decide, assertInstruments, exitCodeFor, ARM, VERDICT } from './clean-room.mjs';

// tkt-b86d2a318f8b — this probe exists so that "I could not determine this" is never reported
// as "no instructions were loaded". Everything below pins that one property, because it is the
// only failure that matters and the one a green suite would otherwise hide.

const HERE = dirname(fileURLToPath(import.meta.url));

describe('classifyArm', () => {
  it.each([['YES'], ['yes'], ['Yes.'], ['YES\n']])('reads %s as the marker being present', (stdout) => {
    expect(classifyArm({ stdout })).toBe(ARM.PRESENT);
  });

  it.each([['NO'], ['no'], ['No.'], ['NO\n']])('reads %s as the marker being absent', (stdout) => {
    expect(classifyArm({ stdout })).toBe(ARM.ABSENT);
  });

  // Every AUTH_BLOCKED pattern gets its own case. The previous suite pinned one of seven:
  // the rest were already caught by the strict-answer fallthrough, so deleting them left it green.
  // These strings each carry a bare answer in stdout, so ONLY the auth scan can classify them.
  it.each([
    ['Not logged in · Please run /login'],
    ['Please run /login to continue'],
    ['Failed to authenticate.'],
    ['API Error: 401 unauthorized'],
    ['Invalid API key provided'],
    ['API key is invalid.'],
    ['Your credit balance is too low'],
  ])('treats %s on stderr as BLOCKED even when stdout carries a clean NO', (stderr) => {
    expect(classifyArm({ stdout: 'NO', stderr, status: 0 })).toBe(ARM.BLOCKED);
  });

  // The bare /401/ this replaced matched the digit sequence anywhere, including a real answer.
  it('does not treat a model answer mentioning 401 as an auth failure', () => {
    expect(classifyArm({ stdout: 'NO', stderr: 'note: 401 tickets were scanned' })).toBe(ARM.ABSENT);
  });

  // THE class of bug the strict match exists for: prose that merely contains "no".
  it.each([
    ['Error: no credentials configured for this workspace.'],
    ['API Error: 429 rate_limit_error. No response available.'],
    ["I can't see my loaded instructions, so no."],
    ['Yes and no, it depends'],
    [''],
    ['   '],
  ])('treats %s as BLOCKED rather than guessing absent', (stdout) => {
    expect(classifyArm({ stdout })).toBe(ARM.BLOCKED);
  });

  it('treats a non-zero exit as BLOCKED even when the output looks like an answer', () => {
    expect(classifyArm({ stdout: 'NO', status: 1 })).toBe(ARM.BLOCKED);
  });

  it('treats a spawn failure as BLOCKED', () => {
    expect(classifyArm({ stdout: '', stderr: 'spawnSync claude ENOENT', status: 1 })).toBe(ARM.BLOCKED);
  });

  it('defaults to BLOCKED when called with nothing at all', () => {
    expect(classifyArm()).toBe(ARM.BLOCKED);
  });
});

describe('decide', () => {
  it('reports CLEAN only for the one pair that earns it', () => {
    expect(decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT }).verdict).toBe(VERDICT.CLEAN);
  });

  it('reports BLOCKED, not CLEAN, when the isolated arm could not run', () => {
    expect(decide({ control: ARM.PRESENT, cleanroom: ARM.BLOCKED }).verdict).toBe(VERDICT.BLOCKED);
  });

  it('reports NOT_ISOLATED when the isolated arm still loaded instructions', () => {
    expect(decide({ control: ARM.PRESENT, cleanroom: ARM.PRESENT }).verdict).toBe(VERDICT.NOT_ISOLATED);
  });

  it.each([[ARM.ABSENT], [ARM.BLOCKED]])('reports INSTRUMENT_BROKEN when the control is %s', (control) => {
    expect(decide({ control, cleanroom: ARM.ABSENT }).verdict).toBe(VERDICT.INSTRUMENT_BROKEN);
  });

  // decide() previously used CLEAN as its fall-through, so an unrecognised or missing arm value
  // — a future classifyArm outcome, a partially-built object — became the permissive answer.
  it.each([
    ['an unknown future outcome', 'TIMEOUT'],
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a lowercase near-miss', 'marker_absent'],
  ])('reports BLOCKED, not CLEAN, for %s as the isolated arm', (_label, cleanroom) => {
    expect(decide({ control: ARM.PRESENT, cleanroom }).verdict).toBe(VERDICT.BLOCKED);
  });

  it('reports INSTRUMENT_BROKEN when called with no arms at all', () => {
    expect(decide().verdict).toBe(VERDICT.INSTRUMENT_BROKEN);
  });

  // The exhaustive guarantee: CLEAN is reachable from exactly one input pair.
  it('returns CLEAN for exactly one combination across every arm value', () => {
    const values = [...Object.values(ARM), 'TIMEOUT', undefined, null, ''];
    const clean = [];
    for (const control of values) {
      for (const cleanroom of values) {
        if (decide({ control, cleanroom }).verdict === VERDICT.CLEAN) clean.push([control, cleanroom]);
      }
    }
    expect(clean).toEqual([[ARM.PRESENT, ARM.ABSENT]]);
  });
});

describe('exitCodeFor', () => {
  // This is the line that authorizes an A/B to proceed, and it was previously unpinned:
  // mutating it to a bare exit(0) left the whole suite green.
  it('exits 0 only for CLEAN', () => {
    expect(exitCodeFor(VERDICT.CLEAN)).toBe(0);
  });

  it.each([[VERDICT.BLOCKED], [VERDICT.NOT_ISOLATED], [VERDICT.INSTRUMENT_BROKEN], ['anything else'], [undefined]])(
    'exits non-zero for %s',
    (verdict) => {
      expect(exitCodeFor(verdict)).not.toBe(0);
    },
  );
});

describe('assertInstruments', () => {
  it('passes on the real module', () => {
    expect(() => assertInstruments()).not.toThrow();
  });
});

describe('CLI entrypoint', () => {
  // The main-module guard was `file://${process.argv[1]}`, which fails to match whenever the
  // path needs URL-escaping — so the CLI silently did nothing and exited 0, the fail-open
  // reading, from a probe that never ran an arm. A space is the cheapest reproduction.
  it('still runs from a path containing a space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clean room probe-'));
    try {
      const copy = join(dir, 'cr.mjs');
      copyFileSync(join(HERE, 'clean-room.mjs'), copy);
      let stdout = '';
      let status = 0;
      try {
        // --question with no value exits 1 before spawning any session, so this exercises the
        // entrypoint without burning a model call.
        stdout = execFileSync(process.execPath, [copy, '--question'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        status = e.status;
        stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(status).toBe(1);            // it ran — a silent no-op would have exited 0
      expect(stdout).toContain('--question requires a value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
