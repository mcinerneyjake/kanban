import { describe, it, expect } from 'vitest';
import { parseVisibility, ALL_VISIBLE } from './dashboardVisibility.js';

describe('parseVisibility', () => {
  it('defaults to all-visible when nothing is stored (null or empty)', () => {
    expect(parseVisibility(null)).toEqual(ALL_VISIBLE);
    expect(parseVisibility('')).toEqual(ALL_VISIBLE);
  });

  it('round-trips a full stored object', () => {
    expect(parseVisibility('{"status":false,"priority":true,"recent":false}')).toEqual({
      status: false, priority: true, recent: false,
    });
  });

  it('defaults a missing widget to visible (partial object — forward compatible)', () => {
    // Only `status` persisted false; a newer `priority`/`recent` default to shown.
    expect(parseVisibility('{"status":false}')).toEqual({
      status: false, priority: true, recent: true,
    });
  });

  it('treats only an explicit false as hidden (truthy/absent → visible)', () => {
    expect(parseVisibility('{"status":true,"priority":0,"recent":null}')).toEqual({
      status: true, priority: true, recent: true,
    });
  });

  it('supports all-hidden', () => {
    expect(parseVisibility('{"status":false,"priority":false,"recent":false}')).toEqual({
      status: false, priority: false, recent: false,
    });
  });

  it('falls back to all-visible on corrupt JSON', () => {
    expect(parseVisibility('{not json')).toEqual(ALL_VISIBLE);
  });

  it('falls back to all-visible for a non-object JSON value', () => {
    expect(parseVisibility('5')).toEqual(ALL_VISIBLE);
    expect(parseVisibility('"nope"')).toEqual(ALL_VISIBLE);
    expect(parseVisibility('null')).toEqual(ALL_VISIBLE);
  });
});
