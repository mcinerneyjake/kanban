import { describe, it, expect } from 'vitest';
import { matchesFilter, filterTickets } from './filterTickets.js';
import { defaultFilter, type FilterState } from '../components/FilterPopover.js';
import type { Ticket } from '../../shared/constants.js';

const mk = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt-1', title: 'Title', type: 'feature', priority: 'medium', status: 'backlog', order: 0,
  created: '2026-07-01T00:00:00.000Z', updated: '2026-07-10T00:00:00.000Z', body: 'Body',
  project: 'kanban', blockers: [], parent: null, dueDate: null, assignee: null,
  ...over,
});

const f = (over: Partial<FilterState> = {}): FilterState => ({ ...defaultFilter, ...over });

describe('matchesFilter', () => {
  it('passes everything under the default (empty) filter', () => {
    expect(matchesFilter(mk(), defaultFilter, '')).toBe(true);
  });

  it('filters by type (multi-select is OR)', () => {
    expect(matchesFilter(mk({ type: 'bug' }), f({ types: ['bug'] }), '')).toBe(true);
    expect(matchesFilter(mk({ type: 'feature' }), f({ types: ['bug'] }), '')).toBe(false);
    expect(matchesFilter(mk({ type: 'chore' }), f({ types: ['bug', 'chore'] }), '')).toBe(true);
  });

  it('filters by priority', () => {
    expect(matchesFilter(mk({ priority: 'high' }), f({ priority: 'high' }), '')).toBe(true);
    expect(matchesFilter(mk({ priority: 'low' }), f({ priority: 'high' }), '')).toBe(false);
  });

  it('filters by project (a null project never matches a set project filter)', () => {
    expect(matchesFilter(mk({ project: 'kanban' }), f({ project: 'kanban' }), '')).toBe(true);
    expect(matchesFilter(mk({ project: 'other' }), f({ project: 'kanban' }), '')).toBe(false);
    expect(matchesFilter(mk({ project: null }), f({ project: 'kanban' }), '')).toBe(false);
  });

  it('filters by assignee (null assignee excluded when a filter is set)', () => {
    expect(matchesFilter(mk({ assignee: 'jake' }), f({ assignee: 'jake' }), '')).toBe(true);
    expect(matchesFilter(mk({ assignee: null }), f({ assignee: 'jake' }), '')).toBe(false);
  });

  it('filters by a created-date range, inclusive on both bounds', () => {
    const t = mk({ created: '2026-07-05T12:00:00.000Z' });
    expect(matchesFilter(t, f({ dateFrom: '2026-07-05', dateTo: '2026-07-05' }), '')).toBe(true); // boundary
    expect(matchesFilter(t, f({ dateFrom: '2026-07-01', dateTo: '2026-07-10' }), '')).toBe(true);
    expect(matchesFilter(t, f({ dateFrom: '2026-07-06' }), '')).toBe(false);
    expect(matchesFilter(t, f({ dateTo: '2026-07-04' }), '')).toBe(false);
  });

  it('honors dateField (updated vs created)', () => {
    const t = mk({ created: '2026-07-01T00:00:00.000Z', updated: '2026-07-20T00:00:00.000Z' });
    expect(matchesFilter(t, f({ dateField: 'updated', dateFrom: '2026-07-15' }), '')).toBe(true);
    expect(matchesFilter(t, f({ dateField: 'created', dateFrom: '2026-07-15' }), '')).toBe(false);
  });

  it('searches title and body, case-insensitively', () => {
    expect(matchesFilter(mk({ title: 'Fix the WIDGET' }), defaultFilter, 'widget')).toBe(true);
    expect(matchesFilter(mk({ title: 'x', body: 'a Gadget here' }), defaultFilter, 'gadget')).toBe(true);
    expect(matchesFilter(mk({ title: 'x', body: 'y' }), defaultFilter, 'zzz')).toBe(false);
  });

  it('ANDs across fields — every active clause must pass', () => {
    const t = mk({ type: 'bug', priority: 'high', project: 'kanban' });
    expect(matchesFilter(t, f({ types: ['bug'], priority: 'high', project: 'kanban' }), '')).toBe(true);
    expect(matchesFilter(t, f({ types: ['bug'], priority: 'low' }), '')).toBe(false);
  });
});

describe('filterTickets', () => {
  it('returns only matching tickets and preserves order', () => {
    const tickets = [mk({ id: 'a', type: 'bug' }), mk({ id: 'b', type: 'feature' }), mk({ id: 'c', type: 'bug' })];
    expect(filterTickets(tickets, f({ types: ['bug'] }), '').map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('returns all tickets under the default filter', () => {
    const tickets = [mk({ id: 'a' }), mk({ id: 'b' })];
    expect(filterTickets(tickets, defaultFilter, '')).toHaveLength(2);
  });
});
