import { useEffect, useState } from 'react';
import { api } from './api.js';
import { isTicketEventsResponse } from './lib/terminalRelay.js';
import type { TicketEventsResponse } from '../shared/constants.js';

const POLL_MS = 2000;

export interface TicketEventsState {
  data: TicketEventsResponse | null
  loading: boolean
  error: boolean
}

// Polls a ticket's events every 2s while live (true only for a non-terminal on-screen ticket; a terminal one fetches once). reloadKey forces an immediate refetch. Polls chain via .finally() so requests never overlap; cancelled drops an in-flight response after unmount (state set only in async callbacks).
export function useTicketEvents(id: string, live: boolean, reloadKey = 0): TicketEventsState {
  const [state, setState] = useState<TicketEventsState>({ data: null, loading: true, error: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      api.events(id)
        // Validated HERE, not per-consumer: api.events types res.json() without checking it, and
        // only TerminalPipelinePhase ran the guard — so a payload missing the required counts
        // reached CardProgress and PipelineTracker as `undefined` behind a type promising a number,
        // where `data.skipped > 0` is silently false and renders a damaged log as healthy
        // (tkt-355581f9dab3). One check at the boundary covers all three.
        .then((data) => {
          if (cancelled) return;
          if (!isTicketEventsResponse(data)) {
            setState((s) => ({ data: s.data, loading: false, error: true }));
            return;
          }
          setState({ data, loading: false, error: false });
        })
        .catch(() => { if (!cancelled) setState((s) => ({ data: s.data, loading: false, error: true })); })
        .finally(() => { if (!cancelled && live) timer = setTimeout(tick, POLL_MS); });
    };
    tick();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id, live, reloadKey]);

  return state;
}
