import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('returns [] for empty or whitespace-only text', () => {
    expect(chunkText('', { size: 10, overlap: 2 })).toEqual([]);
    expect(chunkText('   \n\t ', { size: 10, overlap: 2 })).toEqual([]);
  });

  it('returns a single trimmed chunk when text fits in one window', () => {
    expect(chunkText('  hello  ', { size: 10, overlap: 2 })).toEqual(['hello']);
  });

  it('treats text exactly at the size boundary as a single chunk', () => {
    expect(chunkText('0123456789', { size: 10, overlap: 3 })).toEqual(['0123456789']);
  });

  it('splits oversized text into overlapping windows covering the whole text', () => {
    // size 4, overlap 1 → step 3 over "0123456789" (len 10)
    expect(chunkText('0123456789', { size: 4, overlap: 1 })).toEqual(['0123', '3456', '6789']);
  });

  it('overlaps consecutive chunks by exactly `overlap` characters', () => {
    const chunks = chunkText('0123456789', { size: 4, overlap: 1 });
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].slice(-1)).toBe(chunks[i + 1].slice(0, 1));
    }
  });

  it('produces contiguous, gapless chunks when overlap is 0', () => {
    const chunks = chunkText('0123456789', { size: 4, overlap: 0 });
    expect(chunks).toEqual(['0123', '4567', '89']);
    expect(chunks.join('')).toBe('0123456789'); // no overlap → concatenation is the text
  });

  it('trims before measuring, so surrounding whitespace does not create stray chunks', () => {
    expect(chunkText('   0123456789   ', { size: 4, overlap: 0 }).join('')).toBe('0123456789');
  });

  it('rejects a non-positive or non-integer size', () => {
    expect(() => chunkText('x', { size: 0, overlap: 0 })).toThrow(/size must be a positive integer/);
    expect(() => chunkText('x', { size: -5, overlap: 0 })).toThrow(/size must be a positive integer/);
    expect(() => chunkText('x', { size: 4.5, overlap: 0 })).toThrow(/size must be a positive integer/);
  });

  it('rejects an overlap outside [0, size)', () => {
    expect(() => chunkText('x', { size: 4, overlap: 4 })).toThrow(/overlap must be an integer in \[0, size\)/);
    expect(() => chunkText('x', { size: 4, overlap: 5 })).toThrow(/overlap must be an integer in \[0, size\)/);
    expect(() => chunkText('x', { size: 4, overlap: -1 })).toThrow(/overlap must be an integer in \[0, size\)/);
  });
});
