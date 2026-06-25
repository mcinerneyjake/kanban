import { useEffect, useState } from 'react';
import { api, type IntakeMatch } from './api.js';
import { intakeQuery } from './lib/intakeQuery.js';
import { visibleMatches } from './lib/visibleMatches.js';

const DEBOUNCE_MS = 350;

export interface RelatedTickets { matches: IntakeMatch[]; loading: boolean; error: boolean }

type SearchState = { query: string; phase: 'loading' | 'done' | 'error'; matches: IntakeMatch[] };

// Debounced semantic "related tickets" lookup for the create modal. The whole
// search outcome (matches / loading / error) is kept in one query-tagged state
// and reported for the CURRENT query only — so a stale response, a half-typed
// new query, or a cleared title never shows the wrong state (no reset needed).
// A `cancelled` flag drops a stale response; failures surface as `error` (a
// hint, never a blocker). State is only set in async callbacks, never
// synchronously in the effect body (react-hooks/set-state-in-effect).
export function useRelatedTickets(title: string, enabled: boolean): RelatedTickets {
  const [search, setSearch] = useState<SearchState>({ query: '', phase: 'done', matches: [] });
  const query = enabled ? intakeQuery(title) : null;

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      setSearch({ query, phase: 'loading', matches: [] });
      api.intake.search(query, 5)
        .then((r) => { if (!cancelled) setSearch({ query, phase: 'done', matches: r.results }); })
        .catch(() => { if (!cancelled) setSearch({ query, phase: 'error', matches: [] }); });
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);

  const isCurrent = query !== null && search.query === query;
  return {
    matches: visibleMatches(search, query),
    loading: isCurrent && search.phase === 'loading',
    error: isCurrent && search.phase === 'error',
  };
}
