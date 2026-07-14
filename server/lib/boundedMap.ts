// A Map with a hard size cap that evicts the OLDEST entry (FIFO by first insertion)
// when a new key exceeds the cap — a backstop against unbounded growth.
// Eviction is purely count-based (not a wall-clock TTL) on purpose: a walked-away
// draft must keep its provenance and an applied runId must stay idempotent for the
// process life — a TTL would break both. The cap drops the oldest (longest-idle) entry.
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  set(key: string, value: V): void {
    // Re-setting an existing key writes in place (no eviction) and keeps its
    // FIRST-insertion FIFO position — an update never jumps the queue.
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
