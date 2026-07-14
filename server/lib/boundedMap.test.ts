import { describe, it, expect } from 'vitest';
import { BoundedMap } from './boundedMap.js';

describe('BoundedMap', () => {
  it('stores and returns a value', () => {
    const map = new BoundedMap<number>(10);
    map.set('a', 1);
    expect(map.get('a')).toBe(1);
    expect(map.size).toBe(1);
  });

  it('get on a missing key returns undefined', () => {
    const map = new BoundedMap<number>(10);
    expect(map.get('nope')).toBeUndefined();
  });

  it('delete removes an entry', () => {
    const map = new BoundedMap<number>(10);
    map.set('a', 1);
    map.delete('a');
    expect(map.get('a')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  // The property the intake maps rely on: nothing is evicted until the cap is hit, so a
  // draft (or applied runId) is never dropped by unrelated churn below the cap — the
  // regression a wall-clock TTL would have introduced.
  it('keeps every entry while under the cap, regardless of churn', () => {
    const map = new BoundedMap<string>(1000);
    map.set('draft', 'pending');
    for (let i = 0; i < 500; i++) map.set(`other-${i}`, 'x');
    expect(map.get('draft')).toBe('pending');
    expect(map.size).toBe(501);
  });

  it('evicts the oldest entry once the cap is exceeded', () => {
    const map = new BoundedMap<number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('d', 4); // size would be 4 > cap 3 → oldest ('a') evicted
    expect(map.get('a')).toBeUndefined();
    expect(map.get('b')).toBe(2);
    expect(map.get('d')).toBe(4);
    expect(map.size).toBe(3);
  });

  // Re-setting an existing key updates it in place — no growth, no eviction — and
  // keeps its original FIFO position (pure first-insertion order, no recency bump).
  it('updates an existing key in place without evicting or growing', () => {
    const map = new BoundedMap<number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('a', 10); // in-place update at the cap — must not evict 'b'
    expect(map.get('a')).toBe(10);
    expect(map.get('b')).toBe(2);
    expect(map.get('c')).toBe(3);
    expect(map.size).toBe(3);
    map.set('d', 4); // 'a' kept its first-insertion slot, so it's still the oldest
    expect(map.get('a')).toBeUndefined();
    expect(map.get('d')).toBe(4);
  });

  it('a cap of 1 keeps only the most recent entry', () => {
    const map = new BoundedMap<number>(1);
    map.set('a', 1);
    map.set('b', 2);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('b')).toBe(2);
    expect(map.size).toBe(1);
  });

  it('a cap of 0 holds nothing', () => {
    const map = new BoundedMap<number>(0);
    map.set('a', 1);
    expect(map.get('a')).toBeUndefined();
    expect(map.size).toBe(0);
  });
});
