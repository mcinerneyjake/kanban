import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { TicketEventsResponse } from '../shared/constants.js';

const POLL_MS = 2000;

export interface TicketEventsState {
  data: TicketEventsResponse | null
  loading: boolean
  error: boolean
}

// Fetches a ticket's workflow-milestone events, polling every 2s while `live`.
// `live` should be true only for a non-terminal ticket whose tracker is on
// screen (in-progress/qa); a terminal ticket fetches once. Bumping `reloadKey`
// forces an immediate refetch (e.g. right after marking review). Polls are
// chained via .finally() so requests never overlap, and a `cancelled` flag drops
// any in-flight response after unmount — state is only set in async callbacks
// (react-hooks/set-state-in-effect), matching useRelatedTickets.
export function useTicketEvents(id: string, live: boolean, reloadKey = 0): TicketEventsState {
  const [state, setState] = useState<TicketEventsState>({ data: null, loading: true, error: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      api.events(id)
        .then((data) => { if (!cancelled) setState({ data, loading: false, error: false }); })
        .catch(() => { if (!cancelled) setState((s) => ({ data: s.data, loading: false, error: true })); })
        .finally(() => { if (!cancelled && live) timer = setTimeout(tick, POLL_MS); });
    };
    tick();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id, live, reloadKey]);

  return state;
}
