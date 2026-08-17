import { useEffect, useState, useCallback } from 'react';
import { latestOnly, settleLatest } from './lib/latestOnly.js';

// Fetch on mount + refreshKey bump, poll on intervalMs (0 disables). data is null until the first fetch resolves (loading = data === null && error === null). fetcher MUST be stable (useCallback) or the effects re-subscribe each render.
export function usePolledSummary<T>(
  fetcher: () => Promise<T>,
  refreshKey: number,
  intervalMs: number,
): { data: T | null; error: string | null; setError: (e: string | null) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest-request-wins. One gate for BOTH effects — the poll and the refresh/mount fetch overlap each
  // other, so a guard scoped to one effect run would let the other's stale response through
  // (tkt-39b6d93433a2). Ordering logic lives in src/lib/latestOnly.ts, where it is testable.
  // useState's lazy initializer, not useRef(latestOnly()): the factory then runs once rather than on
  // every render, and there is no ref-in-cleanup lint exception to justify.
  const [gate] = useState(latestOnly);

  const load = useCallback(() => {
    void settleLatest(fetcher, gate, (d) => { setData(d); setError(null); }, setError);
  }, [fetcher, gate]);

  useEffect(() => {
    load();
    // Unmount, or a changed fetcher/refreshKey, supersedes anything still in flight.
    return () => { gate.supersede(); };
  }, [load, refreshKey, gate]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(load, intervalMs);
    return () => clearInterval(id);
  }, [load, intervalMs]);

  return { data, error, setError };
}
