import { describe, it, expect } from 'vitest';
import { intakeSearchSchema, intakeProposeSchema } from './intake.js';
import { reviewSchema } from './review.js';
import { firstString, parseSearchTerm, parseProjectScope, parseRunId, parseDateBound } from './query.js';
import { ticketId } from './params.js';

describe('intakeSearchSchema', () => {
  it('accepts a query and defaults limit to 5', () => {
    expect(intakeSearchSchema.parse({ query: 'hello' })).toEqual({ query: 'hello', limit: 5 });
  });

  it('trims the query', () => {
    expect(intakeSearchSchema.parse({ query: '  hi  ' }).query).toBe('hi');
  });

  it('honours an explicit numeric limit', () => {
    expect(intakeSearchSchema.parse({ query: 'x', limit: 3 }).limit).toBe(3);
  });

  it('coerces a non-number limit back to 5 (preserves old lenient behaviour)', () => {
    expect(intakeSearchSchema.parse({ query: 'x', limit: 'nope' }).limit).toBe(5);
    expect(intakeSearchSchema.parse({ query: 'x', limit: null }).limit).toBe(5);
  });

  it('rejects a missing query with the "query is required" message', () => {
    const result = intakeSearchSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('query is required');
  });

  it('rejects a whitespace-only query', () => {
    expect(() => intakeSearchSchema.parse({ query: '   ' })).toThrow();
  });
});

describe('intakeProposeSchema', () => {
  it('accepts and trims a report', () => {
    expect(intakeProposeSchema.parse({ report: '  bug  ' })).toEqual({ report: 'bug' });
  });

  it('rejects a missing report', () => {
    expect(() => intakeProposeSchema.parse({})).toThrow();
  });

  it('rejects a whitespace-only report', () => {
    expect(() => intakeProposeSchema.parse({ report: '   ' })).toThrow();
  });
});

describe('reviewSchema', () => {
  it('accepts an empty body (reviewed omitted)', () => {
    expect(reviewSchema.parse({})).toEqual({});
  });

  it('accepts an explicit boolean', () => {
    expect(reviewSchema.parse({ reviewed: false })).toEqual({ reviewed: false });
  });

  it('folds a non-boolean reviewed to undefined (treated as confirm, not a 400)', () => {
    // Old semantics: `req.body?.reviewed !== false` — only literal false
    // un-reviews; a non-boolean stays "reviewed". undefined !== false === true.
    expect(reviewSchema.parse({ reviewed: 'yes' }).reviewed).toBeUndefined();
    expect(reviewSchema.parse({ reviewed: 0 }).reviewed).toBeUndefined();
  });
});

describe('query parsing', () => {
  it('firstString returns single strings and drops arrays/undefined', () => {
    expect(firstString('a')).toBe('a');
    expect(firstString(['a', 'b'])).toBeUndefined();
    expect(firstString(undefined)).toBeUndefined();
  });

  it('parseSearchTerm trims, defaulting to empty when absent or repeated', () => {
    expect(parseSearchTerm('  hi ')).toBe('hi');
    expect(parseSearchTerm(undefined)).toBe('');
    expect(parseSearchTerm(['a'])).toBe('');
  });

  it('parseProjectScope trims or collapses to null', () => {
    expect(parseProjectScope('  kanban ')).toBe('kanban');
    expect(parseProjectScope('   ')).toBeNull();
    expect(parseProjectScope(undefined)).toBeNull();
  });

  it('parseRunId trims or collapses to undefined', () => {
    expect(parseRunId('  run-1 ')).toBe('run-1');
    expect(parseRunId('   ')).toBeUndefined();
    expect(parseRunId(undefined)).toBeUndefined();
    expect(parseRunId(['a'])).toBeUndefined();
  });

  it('parseDateBound normalizes a bare date to inclusive start/end of day', () => {
    expect(parseDateBound('2026-07-03', 'from')).toBe('2026-07-03T00:00:00.000Z');
    expect(parseDateBound('2026-07-03', 'to')).toBe('2026-07-03T23:59:59.999Z');
  });

  it('parseDateBound passes a full ISO timestamp through unchanged', () => {
    expect(parseDateBound('2026-07-03T09:30:00.000Z', 'from')).toBe('2026-07-03T09:30:00.000Z');
    expect(parseDateBound('2026-07-03T09:30:00+02:00', 'to')).toBe('2026-07-03T09:30:00+02:00');
  });

  it('parseDateBound returns undefined for absent/blank/repeated values', () => {
    expect(parseDateBound(undefined, 'from')).toBeUndefined();
    expect(parseDateBound('   ', 'to')).toBeUndefined();
    expect(parseDateBound(['2026-07-03'], 'from')).toBeUndefined();
  });
});

describe('ticketId', () => {
  it('returns a plain string param', () => {
    expect(ticketId({ params: { id: 'tkt-1' } })).toBe('tkt-1');
  });

  it('rejects an array param (wildcard segments) with a 400', () => {
    expect(() => ticketId({ params: { id: ['a', 'b'] } })).toThrow('Invalid :id parameter');
  });
});
