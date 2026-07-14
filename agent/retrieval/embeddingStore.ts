import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Persistent content-addressed embedding cache: the key is a hash of the embedded TEXT, so identical content maps to one vector and is embedded once (regardless of a record's `updated` stamp). JSON map on disk; SQLite is the scale-up path (the CachingEmbedder seam above wouldn't change).

// Content hash for a piece of text — the cache key.
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Cast-free validation of the on-disk shape so a hand-edited/truncated file can't inject a malformed vector that later crashes cosineSimilarity. Vectors must be NON-EMPTY and share one dimension — a ragged/empty entry rejects the whole cache.
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

  // A missing/corrupt file yields an empty store — best-effort, never fatal (a bad cache degrades to re-embedding, not a crash).
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

  // Drop entries not in `keep`, bounding growth to the current corpus so edited/removed content doesn't accumulate forever.
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

  // Atomic temp-file + rename so a crash mid-write can't leave a half-written corrupt cache. No-op when nothing changed since load/persist (an unchanged warm start writes nothing).
  async persist(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.vectors)));
    await fs.rename(tmp, this.filePath);
    this.dirty = false;
  }
}
