import { describe, it, expect } from 'vitest';
import { isActiveBlocker, computeActiveBlockerCounts, ticketsBlockedBy } from './blockers.js';
import type { Ticket, StatusId } from '../../shared/constants.js';

// Minimal fixture — only id, status, and blockers matter to this module.
const mk = (id: string, status: StatusId, blockers: string[] = []): Ticket => ({
  id, title: id, type: 'task', priority: 'medium', status, order: 0,
  created: '', updated: '', body: '', project: null, blockers,
  parent: null, dueDate: null, assignee: null,
});

describe('isActiveBlocker', () => {
  it('treats board-live statuses as active', () => {
    expect(isActiveBlocker('todo')).toBe(true);
    expect(isActiveBlocker('in-progress')).toBe(true);
    expect(isActiveBlocker('backlog')).toBe(true);
  });

  it('treats done and archived as inactive', () => {
    expect(isActiveBlocker('done')).toBe(false);
    expect(isActiveBlocker('archived')).toBe(false);
  });
});

describe('computeActiveBlockerCounts', () => {
  it('counts a live blocker', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'in-progress')];
    expect(computeActiveBlockerCounts(tickets)).toEqual({ a: 1 });
  });

  it('excludes a done blocker (the core fix)', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'done')];
    expect(computeActiveBlockerCounts(tickets)).toEqual({});
  });

  it('excludes an archived blocker', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'archived')];
    expect(computeActiveBlockerCounts(tickets)).toEqual({});
  });

  it('excludes a dangling blocker id (target deleted / missing)', () => {
    const tickets = [mk('a', 'todo', ['ghost'])];
    expect(computeActiveBlockerCounts(tickets)).toEqual({});
  });

  it('counts only the active subset of a mixed blocker set', () => {
    const tickets = [
      mk('a', 'todo', ['b', 'c', 'd', 'ghost']),
      mk('b', 'in-progress'), mk('c', 'done'), mk('d', 'todo'),
    ];
    expect(computeActiveBlockerCounts(tickets)).toEqual({ a: 2 });
  });

  it('counts independently across tickets and omits zero-count entries', () => {
    const tickets = [
      mk('a', 'todo', ['x']), mk('b', 'todo', ['y']), mk('c', 'todo', ['z']),
      mk('x', 'todo'), mk('y', 'done'), mk('z', 'todo'),
    ];
    expect(computeActiveBlockerCounts(tickets)).toEqual({ a: 1, c: 1 });
  });
});

describe('ticketsBlockedBy', () => {
  it('returns the tickets that list the id as a blocker', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('c', 'todo', ['b']), mk('b', 'todo')];
    expect(ticketsBlockedBy('b', tickets).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('drops archived dependents but keeps done ones', () => {
    const tickets = [
      mk('a', 'done', ['b']), mk('c', 'archived', ['b']), mk('d', 'todo', ['b']),
    ];
    expect(ticketsBlockedBy('b', tickets).map((t) => t.id)).toEqual(['a', 'd']);
  });

  it('returns empty when nothing is blocked by the id', () => {
    const tickets = [mk('a', 'todo'), mk('b', 'todo', ['a'])];
    expect(ticketsBlockedBy('z', tickets)).toEqual([]);
  });
});
