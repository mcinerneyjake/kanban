import { describe, it, expect } from 'vitest';
import { validateSetupToken } from './terminalSeed.mjs';

const GOOD = `sk-ant-oat01-${'a'.repeat(97)}`; // 110 chars, the observed live length

describe('validateSetupToken', () => {
  it('accepts a real-shaped setup token', () => {
    expect(validateSetupToken(GOOD).ok).toBe(true);
  });

  it('rejects empty, whitespace-only, and non-string input', () => {
    for (const bad of ['', '   ', '\n', null, undefined, 42]) {
      expect(validateSetupToken(bad).ok).toBe(false);
    }
  });

  it('rejects a truncated paste even with the right prefix', () => {
    expect(validateSetupToken('sk-ant-oat01-abc').reason).toContain('truncated');
  });

  // The single most likely wrong clipboard, and the one the old `sk-ant-` prefix let through.
  it('rejects an Anthropic API key', () => {
    const r = validateSetupToken(`sk-ant-api03-${'x'.repeat(95)}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('sk-ant-oat');
  });

  // Pins the INVERSE of what tkt-bfb3bc9f98d4 briefly asserted. Whitespace looks like a truncated
  // paste, but the live working credential contains internal whitespace (raw 110 == trimmed 110),
  // so rejecting it locked out a valid token. Do not reintroduce the rule (tkt-7b21fb0b3307).
  it('accepts a token containing internal whitespace, as real tokens do', () => {
    expect(validateSetupToken(`sk-ant-oat01-${'a'.repeat(50)} ${'b'.repeat(46)}`).ok).toBe(true);
    expect(validateSetupToken(`sk-ant-oat01-${'a'.repeat(50)}\n${'b'.repeat(46)}`).ok).toBe(true);
  });

  it('rejects a long non-token value such as a pasted URL', () => {
    expect(validateSetupToken('https://console.anthropic.com/settings/keys?tab=oauth&pad=xxxxxxxxxx').ok).toBe(false);
  });

  it('accepts an unexpected prefix only under --force', () => {
    const odd = `weird-prefix-${'b'.repeat(60)}`;
    expect(validateSetupToken(odd).ok).toBe(false);
    expect(validateSetupToken(odd, { force: true }).ok).toBe(true);
  });

  // force is an override for the PREFIX rule only — it must not wave through a truncated paste.
  it('does not let --force bypass the length rule', () => {
    expect(validateSetupToken('sk-ant-oat01-abc', { force: true }).ok).toBe(false);
  });

  // Tolerates a version bump (oat02…) without a code change; the old `sk-ant-` did not discriminate.
  it('accepts a future oat version', () => {
    expect(validateSetupToken(`sk-ant-oat02-${'a'.repeat(97)}`).ok).toBe(true);
  });
});
