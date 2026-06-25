import { type IntakeMatch } from '../api.js';

// Minimum cosine score for a match to be worth showing in the strip.
const MIN_SCORE = 0.3;

// What the related-tickets strip should display: nothing unless the cached
// results belong to the CURRENT query (guards against a stale/slow response or
// a half-typed new query showing the wrong matches), and only matches above the
// relevance floor.
export function visibleMatches(
  cached: { query: string; matches: IntakeMatch[] },
  currentQuery: string | null,
): IntakeMatch[] {
  if (!currentQuery || cached.query !== currentQuery) return [];
  return cached.matches.filter((m) => m.score >= MIN_SCORE);
}
