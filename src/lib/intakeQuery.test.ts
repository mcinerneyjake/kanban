import { describe, it, expect } from 'vitest';
import { intakeQuery } from './intakeQuery.js';

describe('intakeQuery', () => {
  it('combines title + body when long enough', () => {
    expect(intakeQuery('Login is broken', '')).toBe('Login is broken');
    expect(intakeQuery('PDF', 'export cuts off the footer')).toBe('PDF export cuts off the footer');
  });

  it('returns null for short or empty input (avoids noise round-trips)', () => {
    expect(intakeQuery('', '')).toBeNull();
    expect(intakeQuery('fix', '')).toBeNull();
    expect(intakeQuery('   ', '  ')).toBeNull();
  });
});
