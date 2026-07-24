import { describe, it, expect } from 'vitest';
import { serializeBuffer, type ReadableBuffer } from './terminalBuffer';

// A fake buffer whose lines are already right-trimmed strings; getLine mimics xterm's
// translateToString(trimRight) by returning the stored line regardless of the flag.
const buf = (lines: (string | undefined)[]): ReadableBuffer => ({
  length: lines.length,
  getLine: (y) => {
    const line = lines[y];
    return line === undefined ? undefined : { translateToString: () => line };
  },
});

describe('serializeBuffer', () => {
  it('joins lines with newlines', () => {
    expect(serializeBuffer(buf(['one', 'two', 'three']))).toBe('one\ntwo\nthree');
  });

  it('drops trailing blank lines but keeps interior ones', () => {
    expect(serializeBuffer(buf(['a', '', 'b', '', '']))).toBe('a\n\nb');
  });

  it('returns empty string for an empty buffer', () => {
    expect(serializeBuffer(buf([]))).toBe('');
  });

  it('returns empty string for a blank-only buffer', () => {
    expect(serializeBuffer(buf(['', '', '']))).toBe('');
  });

  it('tolerates a getLine that returns undefined (treated as blank)', () => {
    expect(serializeBuffer(buf(['a', undefined, 'b']))).toBe('a\n\nb');
  });

  it('preserves the right-trimmed line content verbatim', () => {
    expect(serializeBuffer(buf(['  indented', 'tab\tsep']))).toBe('  indented\ntab\tsep');
  });
});
