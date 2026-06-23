import { describe, it, expect } from 'vitest';
import { encode, decode } from './filterParams.js';
import { defaultFilter } from '../components/FilterPopover.js';

describe('encode', () => {
  it('produces empty params for the default filter', () => {
    expect(encode(defaultFilter).toString()).toBe('');
  });

  it('encodes types as repeated params', () => {
    const p = encode({ ...defaultFilter, types: ['bug', 'feature'] });
    expect(p.getAll('type')).toEqual(['bug', 'feature']);
  });

  it('omits priority when empty', () => {
    expect(encode(defaultFilter).has('priority')).toBe(false);
  });

  it('includes priority when set', () => {
    expect(encode({ ...defaultFilter, priority: 'high' }).get('priority')).toBe('high');
  });

  it('omits sort when default', () => {
    expect(encode(defaultFilter).has('sort')).toBe(false);
  });

  it('includes sort when non-default', () => {
    expect(encode({ ...defaultFilter, sort: 'priority' }).get('sort')).toBe('priority');
  });

  it('omits dateField when default', () => {
    expect(encode(defaultFilter).has('dateField')).toBe(false);
  });

  it('includes dateField when non-default', () => {
    expect(encode({ ...defaultFilter, dateField: 'updated' }).get('dateField')).toBe('updated');
  });

  it('includes dateFrom and dateTo when set', () => {
    const p = encode({ ...defaultFilter, dateFrom: '2026-01-01', dateTo: '2026-06-30' });
    expect(p.get('dateFrom')).toBe('2026-01-01');
    expect(p.get('dateTo')).toBe('2026-06-30');
  });

  it('omits assignee when empty', () => {
    expect(encode(defaultFilter).has('assignee')).toBe(false);
  });

  it('includes assignee when set', () => {
    expect(encode({ ...defaultFilter, assignee: 'Jake' }).get('assignee')).toBe('Jake');
  });
});

describe('decode', () => {
  it('returns default filter for empty params', () => {
    expect(decode(new URLSearchParams())).toEqual(defaultFilter);
  });

  it('restores types', () => {
    expect(decode(new URLSearchParams('type=bug&type=feature')).types).toEqual(['bug', 'feature']);
  });

  it('ignores unknown type values', () => {
    expect(decode(new URLSearchParams('type=invalid&type=bug')).types).toEqual(['bug']);
  });

  it('ignores unknown priority, falls back to empty', () => {
    expect(decode(new URLSearchParams('priority=invalid')).priority).toBe('');
  });

  it('ignores unknown sort, falls back to default', () => {
    expect(decode(new URLSearchParams('sort=invalid')).sort).toBe('order');
  });

  it('ignores unknown dateField, falls back to default', () => {
    expect(decode(new URLSearchParams('dateField=invalid')).dateField).toBe('created');
  });

  it('restores project as-is', () => {
    expect(decode(new URLSearchParams('project=kanban')).project).toBe('kanban');
  });

  it('restores date range', () => {
    const f = decode(new URLSearchParams('dateFrom=2026-01-01&dateTo=2026-06-30'));
    expect(f.dateFrom).toBe('2026-01-01');
    expect(f.dateTo).toBe('2026-06-30');
  });

  it('restores assignee as-is', () => {
    expect(decode(new URLSearchParams('assignee=Jake')).assignee).toBe('Jake');
  });
});

describe('round-trip', () => {
  it('encode → decode returns the original filter', () => {
    const filter = {
      types: ['bug' as const, 'feature' as const],
      priority: 'high' as const,
      project: 'kanban',
      assignee: 'Jake',
      sort: 'priority' as const,
      dateField: 'updated' as const,
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
    };
    expect(decode(encode(filter))).toEqual(filter);
  });

  it('round-trips the default filter to itself', () => {
    expect(decode(encode(defaultFilter))).toEqual(defaultFilter);
  });
});
