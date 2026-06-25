import { describe, it, expect } from 'vitest';
import { visibleMatches } from './visibleMatches.js';
import { type IntakeMatch } from '../api.js';

const m = (id: string, score: number): IntakeMatch => ({ id, title: id, status: 'backlog', score });

describe('visibleMatches', () => {
  it('shows matches when the cache belongs to the current query', () => {
    const cached = { query: 'login', matches: [m('a', 0.8), m('b', 0.5)] };
    expect(visibleMatches(cached, 'login').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('shows nothing when the cached query is stale (different current query)', () => {
    const cached = { query: 'login', matches: [m('a', 0.8)] };
    expect(visibleMatches(cached, 'dashboard')).toEqual([]);
  });

  it('shows nothing for a null query (empty/short title)', () => {
    const cached = { query: 'login', matches: [m('a', 0.8)] };
    expect(visibleMatches(cached, null)).toEqual([]);
  });

  it('drops matches below the relevance floor', () => {
    const cached = { query: 'login', matches: [m('a', 0.8), m('weak', 0.1)] };
    expect(visibleMatches(cached, 'login').map((x) => x.id)).toEqual(['a']);
  });
});
