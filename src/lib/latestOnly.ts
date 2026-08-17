// Latest-request-wins for overlapping fetches (tkt-39b6d93433a2). Without this, two in-flight requests
// resolve last-write-wins: switch the project filter A→B and if A is slower, A's response lands after B's
// and the view shows A's numbers under B's label until the next refresh.
//
// Lives in src/lib/ so it is testable in this repo's node-env vitest — the hook that uses it is then thin
// enough to need no renderer.
//
// Why a SEQUENCE and not the usual per-effect `let ignore` flag: a flag scoped to one effect run cannot
// separate two requests started *within* that run, which is exactly what `setInterval(load, …)` does when
// a response outlives the poll period. Both would see `ignore === false` and the older would still win.

export interface LatestOnly {
  /** Claim the newest slot; the returned predicate is true only while nothing newer has claimed. */
  claim(): () => boolean
  /** Invalidate everything in flight — effect cleanup, unmount, or a changed fetcher. */
  supersede(): void
}

export function latestOnly(): LatestOnly {
  let newest = 0;
  return {
    claim() {
      const mine = ++newest;
      return () => mine === newest;
    },
    supersede() {
      newest++;
    },
  };
}

/**
 * Run `fetch` and deliver its outcome only if no newer call has started since. Both the success and the
 * failure path are gated: a superseded rejection setting an error is the same defect wearing a different
 * hat — it would surface project A's failure against project B.
 */
export async function settleLatest<T>(
  fetch: () => Promise<T>,
  gate: LatestOnly,
  onData: (data: T) => void,
  onError: (message: string) => void,
): Promise<void> {
  const isCurrent = gate.claim();
  try {
    const data = await fetch();
    if (isCurrent()) onData(data);
  } catch (err) {
    if (isCurrent()) onError(err instanceof Error ? err.message : String(err));
  }
}
