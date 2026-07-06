import { describe, it, expect } from 'vitest';
import { formatIso } from './formatDate.js';

describe('formatIso', () => {
  it('applies the formatter to a parseable ISO timestamp', () => {
    // Format via UTC getters so the assertion is timezone-independent.
    const out = formatIso('2026-07-04T09:30:00.000Z', (d) => `${d.getUTCHours()}:${d.getUTCMinutes()}`);
    expect(out).toBe('9:30');
  });
  it('falls back to the raw string when the value cannot be parsed', () => {
    expect(formatIso('not-a-date', (d) => d.toISOString())).toBe('not-a-date');
    expect(formatIso('', (d) => d.toISOString())).toBe('');
  });
});
