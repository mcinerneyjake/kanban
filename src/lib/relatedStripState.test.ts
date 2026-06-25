import { describe, it, expect } from 'vitest';
import { relatedStripState } from './relatedStripState.js';

describe('relatedStripState', () => {
  it('shows the list when there are matches (even while a refresh is loading)', () => {
    expect(relatedStripState(true, false, false)).toBe('list');
    expect(relatedStripState(true, true, false)).toBe('list');
  });

  it('shows the spinner while searching with no matches yet', () => {
    expect(relatedStripState(false, true, false)).toBe('searching');
  });

  it('shows the error line when a failed search left no matches', () => {
    expect(relatedStripState(false, false, true)).toBe('error');
  });

  it('is hidden when idle with no matches and no error', () => {
    expect(relatedStripState(false, false, false)).toBe('hidden');
  });
});
