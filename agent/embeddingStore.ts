import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Persistent embedding cache. Embedding is the expensive step; re-running it for
// unchanged content on every board change (and again on every process restart)
// is the pain point called out in indexCache.ts. This is a content-addressed
// store: the cache key is a hash of the embedded TEXT, so identical content —
// an unchanged ticket body, a chunk repeated across documents — maps to one
// vector and is embedded once, whether or not a record's `updated` stamp moved.
//
// Local-only (residency) and dependency-free: persisted as a JSON map on disk.
// A binary column store / SQLite is the scale-up path once the JSON grows large
// (many thousands of chunks); the CachingEmbedder seam above it wouldn't change.
// ---------------------------------------------------------------------------

// Content hash for a piece of text — the cache key.
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Validate the on-disk shape (a map of hash → number[]) without casts, so a
// hand-edited or truncated cache file can never inject a malformed vector that
// later crashes cosineSimilarity. Vectors must be NON-EMPTY and share one
// dimension — a single embedder produces fixed-length vectors, so a ragged or
// empty entry means the file is corrupt and the whole cache is rejected.
function isVectorMap(v: unknown): v is Record<string, number[]> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const vectors = Object.values(v);
  if (!vectors.every((vec) => Array.isArray(vec) && vec.length > 0 && vec.every((n) => typeof n === 'number'))) {
    return false;
  }
  const dim = vectors[0]?.length ?? 0;
  return vectors.every((vec) => vec.length === dim);
}

export class EmbeddingStore {
  // Tracks unpersisted mutations so persist() can no-op when nothing changed.
  private dirty = false;

  private constructor(
    private readonly filePath: string,
    private readonly vectors: Map<string, number[]>,
  ) {}

  // Load the cache from disk. A missing or corrupt file yields an empty store —
  // best-effort, never fatal (a bad cache should degrade to re-embedding, not
  // crash the agent). A warm start over a valid file re-embeds nothing.
  static async load(filePath: string): Promise<EmbeddingStore> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (isVectorMap(raw)) {
        return new EmbeddingStore(filePath, new Map(Object.entries(raw)));
      }
    } catch {
      // fall through to an empty store
    }
    return new EmbeddingStore(filePath, new Map());
  }

  has(hash: string): boolean {
    return this.vectors.has(hash);
  }

  get(hash: string): number[] | undefined {
    return this.vectors.get(hash);
  }

  set(hash: string, vector: number[]): void {
    this.vectors.set(hash, vector);
    this.dirty = true;
  }

  // Drop entries whose hash is not in `keep`, bounding growth to the current
  // corpus so content that was edited or removed doesn't accumulate forever.
  prune(keep: Set<string>): void {
    for (const hash of this.vectors.keys()) {
      if (!keep.has(hash)) {
        this.vectors.delete(hash);
        this.dirty = true;
      }
    }
  }

  get size(): number {
    return this.vectors.size;
  }

  // Persist to disk atomically (write a temp file, then rename) so a crash
  // mid-write can't leave a half-written, corrupt cache. No-op when nothing has
  // changed since the last load/persist — so an unchanged warm start writes
  // nothing (and doesn't create an empty file).
  async persist(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.vectors)));
    await fs.rename(tmp, this.filePath);
    this.dirty = false;
  }
}
