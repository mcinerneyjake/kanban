import { describe, it, expect } from 'vitest';
import { classifyArm, decide, VERDICT } from './clean-room.mjs';

// tkt-b86d2a318f8b — the whole point of this probe is that "I could not determine this"
// must never be reported as "no instructions were loaded". These pin that, because it is
// the one failure the probe exists to prevent and the one nothing else would catch.

describe('classifyArm', () => {
  it('reads a bare YES as the marker being present', () => {
    expect(classifyArm({ stdout: 'YES\n' })).toBe('MARKER_PRESENT');
  });

  it('reads a bare NO as the marker being absent', () => {
    expect(classifyArm({ stdout: 'NO\n' })).toBe('MARKER_ABSENT');
  });

  // Observed verbatim on this machine, from both `--bare` and an isolated CLAUDE_CONFIG_DIR.
  it.each([
    ['Not logged in · Please run /login', 'not-logged-in'],
    ['Failed to authenticate. API Error: 401 API key is invalid.', 'invalid-key'],
  ])('treats %s as BLOCKED, never as absent', (stdout) => {
    expect(classifyArm({ stdout })).toBe('BLOCKED');
  });

  it('treats a non-zero exit as BLOCKED even when the output looks like an answer', () => {
    expect(classifyArm({ stdout: 'NO', status: 1 })).toBe('BLOCKED');
  });

  it('treats an ambiguous answer as BLOCKED rather than guessing absent', () => {
    expect(classifyArm({ stdout: 'Yes and no, it depends' })).toBe('BLOCKED');
    expect(classifyArm({ stdout: '' })).toBe('BLOCKED');
  });

  // The failure this ordering exists to prevent: a missing binary yields an error string
  // with no YES/NO in it, which must not fall through to "absent".
  it('treats a spawn failure as BLOCKED', () => {
    expect(classifyArm({ stdout: '', stderr: 'spawnSync claude ENOENT', status: 1 })).toBe('BLOCKED');
  });

  // This is the case that makes the AUTH_BLOCKED scan load-bearing, and it was missing:
  // the cases above are already caught by the ambiguous-answer fallthrough, so deleting
  // the whole auth scan left them green. Here stdout parses cleanly as "absent" while the
  // real story is on stderr — without the scan this returns MARKER_ABSENT, which is the
  // exact fail-open the probe exists to prevent.
  it('treats an auth failure on stderr as BLOCKED even when stdout carries a clean NO', () => {
    expect(classifyArm({ stdout: 'NO', stderr: 'Not logged in · Please run /login', status: 0 }))
      .toBe('BLOCKED');
  });
});

describe('decide', () => {
  it('reports CLEAN only when the control saw the marker and the isolated arm did not', () => {
    expect(decide({ control: 'MARKER_PRESENT', cleanroom: 'MARKER_ABSENT' }).verdict).toBe(VERDICT.CLEAN);
  });

  // THE load-bearing case. A blocked clean arm looks exactly like a clean one from the
  // outside — both fail to find the marker — and calling it CLEAN would green-light an A/B
  // whose arms both carry the instructions under test.
  it('reports BLOCKED, not CLEAN, when the isolated arm could not run', () => {
    const r = decide({ control: 'MARKER_PRESENT', cleanroom: 'BLOCKED' });
    expect(r.verdict).toBe(VERDICT.BLOCKED);
    expect(r.verdict).not.toBe(VERDICT.CLEAN);
  });

  it('reports NOT_ISOLATED when the isolated arm still loaded instructions', () => {
    expect(decide({ control: 'MARKER_PRESENT', cleanroom: 'MARKER_PRESENT' }).verdict).toBe(VERDICT.NOT_ISOLATED);
  });

  // The control is what makes any "absent" believable, so it is checked first and
  // unconditionally — including in the case that would otherwise look like a perfect result.
  it.each([
    ['MARKER_ABSENT', 'control did not find a marker known to be present'],
    ['BLOCKED', 'control could not run at all'],
  ])('reports INSTRUMENT_BROKEN when the control is %s', (control) => {
    expect(decide({ control, cleanroom: 'MARKER_ABSENT' }).verdict).toBe(VERDICT.INSTRUMENT_BROKEN);
  });

  it('prefers INSTRUMENT_BROKEN over CLEAN when both arms are unusable', () => {
    // Without the control-first ordering this pair reads as a textbook clean room.
    expect(decide({ control: 'BLOCKED', cleanroom: 'MARKER_ABSENT' }).verdict).toBe(VERDICT.INSTRUMENT_BROKEN);
  });

  it('never returns CLEAN for any input where the control did not see the marker', () => {
    for (const control of ['MARKER_ABSENT', 'BLOCKED']) {
      for (const cleanroom of ['MARKER_ABSENT', 'MARKER_PRESENT', 'BLOCKED']) {
        expect(decide({ control, cleanroom }).verdict).not.toBe(VERDICT.CLEAN);
      }
    }
  });
});
