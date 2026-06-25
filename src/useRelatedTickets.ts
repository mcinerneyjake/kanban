import { useEffect, useState } from 'react';
import { api, type IntakeMatch } from './api.js';
import { intakeQuery } from './lib/intakeQuery.js';
import { visibleMatches } from './lib/visibleMatches.js';

const DEBOUNCE_MS = 350;

export interface RelatedTickets { matches: IntakeMatch[]; loading: boolean }

// Debounced semantic "related tickets" lookup for the create modal. `query` is
// derived during render (so an emptied title needs no state cleared); fetched
// results are cached tagged with their query; `visibleMatches` decides what to
// surface (current-query + relevance floor). `loading` tracks the request — on
// when it fires, off when it settles — and a `cancelled` flag drops a stale
// response. Failures are swallowed: dedup is a hint, never a blocker. Every
// setState runs in an async callback (react-hooks/set-state-in-effect).
export function useRelatedTickets(title: string, body: string, enabled: boolean): RelatedTickets {
  const [cached, setCached] = useState<{ query: string; matches: IntakeMatch[] }>({ query: '', matches: [] });
  const [loading, setLoading] = useState(false);
  const query = enabled ? intakeQuery(title, body) : null;

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const search = setTimeout(() => {
      setLoading(true); // request now in flight
      api.intake.search(query, 5)
        .then((r) => { if (!cancelled) setCached({ query, matches: r.results }); })
        .catch(() => { if (!cancelled) setCached({ query, matches: [] }); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(search); };
  }, [query]);

  return { matches: visibleMatches(cached, query), loading };
}
