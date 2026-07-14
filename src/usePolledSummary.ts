import { useEffect, useState, useCallback } from 'react';

// Fetch on mount + refreshKey bump, poll on intervalMs (0 disables). data is null until the first fetch resolves (loading = data === null && error === null). fetcher MUST be stable (useCallback) or the effects re-subscribe each render.
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
