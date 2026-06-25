import { describe, it, expect } from 'vitest';
import { intakeQuery } from './intakeQuery.js';

describe('intakeQuery', () => {
  it('returns the trimmed title when long enough', () => {
    expect(intakeQuery('Login is broken')).toBe('Login is broken');
    expect(intakeQuery('  PDF export bug  ')).toBe('PDF export bug');
  });

  it('returns null for a short or empty title (avoids noise round-trips)', () => {
    expect(intakeQuery('')).toBeNull();
    expect(intakeQuery('fix')).toBeNull();
    expect(intakeQuery('   ')).toBeNull();
  });
});
