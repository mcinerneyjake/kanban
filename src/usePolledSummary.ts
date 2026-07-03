import { useEffect, useState, useCallback } from 'react';

// Shared fetch-poll-refresh machinery for the read-only summary views (the board
// Dashboard + the Economics view). Fetches on mount and whenever `refreshKey`
// bumps (App signals a mutation), polls on `intervalMs` (pass 0 to disable), and
// keeps a dismissable error. `data` is null until the first fetch resolves, so
// callers can render a loading state from `data === null && error === null`.
// `fetcher` MUST be stable (wrap it in useCallback) or the effects re-subscribe
// every render.
export function usePolledSummary<T>(
  fetcher: () => Promise<T>,
  refreshKey: number,
  intervalMs: number,
): { data: T | null; error: string | null; setError: (e: string | null) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetcher()
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [fetcher]);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(load, intervalMs);
    return () => clearInterval(id);
  }, [load, intervalMs]);

  return { data, error, setError };
}
