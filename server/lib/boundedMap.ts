// A Map with a hard size cap that evicts the OLDEST entry (FIFO, by first insertion)
// when a NEW key would exceed the cap — a backstop against unbounded growth, and
// nothing more.
//
// The intake controller keys per-run state (captured usage, applied ticket ids) by
// runId between a `propose` and a later `apply`. In normal single-user use the map
// holds a handful of entries and the cap never fires, so a draft survives however
// long the user reviews it (keeping its provenance + economics on save) and an
// applied runId stays idempotent for the life of the process. Those are exactly the
// properties a wall-clock TTL would have broken — a walked-away draft losing its
// provenance, a late retry minting a duplicate — which is why eviction here is purely
// count-based. When the cap does fire it drops the oldest (longest-idle) entry, the
// one most likely already abandoned.
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  set(key: string, value: V): void {
    // Re-setting an existing key writes in place — no growth, no eviction — and keeps
    // the key's FIRST-insertion FIFO position, so an update never jumps the queue.
    const isNew = !this.entries.has(key);
    this.entries.set(key, value);
    if (isNew && this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
