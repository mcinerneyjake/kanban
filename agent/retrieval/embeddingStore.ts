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

// Disambiguates two persists from the SAME process (pid alone would collide).
let nextTmpSeq = 0;

// Keys are `<nsHash>:<contentHash>` (CachingEmbedder.scope) or a bare hash when unnamespaced.
//
// A key from the PREVIOUS format is a bare hash too, so the unnamespaced scope claims it and prunes
// it away. That is intended: those keys can never be hit again under the new format, and leaving
// them unclaimed would strand them in the file forever — a scoped pruner's version of a leak.
function inScope(key: string, scope: string): boolean {
  return scope === '' ? !key.includes(':') : key.startsWith(scope);
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

  // Drop entries not in `keep`, bounding growth to the current corpus so edited/removed content
  // doesn't accumulate forever — but ONLY within `scope`, the caller's namespace prefix.
  //
  // Namespace-blind pruning was the bug (tkt-aa73a535ec4a): the server and the CLI share one cache
  // file, `keep` only ever holds the hashes of the build that just ran, so a build under one
  // EMBED_MODEL deleted every vector belonging to the other and both re-embedded from cold, forever.
  //
  // `scope` is REQUIRED, not optional-defaulting-to-everything: the permissive default is exactly
  // the old behaviour, and a caller that forgot to pass one would silently reintroduce the defect.
  // Pass '' to deliberately prune the unnamespaced keys (tests).
  prune(keep: Set<string>, scope: string): void {
    for (const hash of this.vectors.keys()) {
      if (!inScope(hash, scope)) continue; // another namespace's entry — not ours to delete
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
    // Unique temp name per write: the server and the CLI now share one cache file
    // (tkt-9f09b3a1e95c), so a fixed `${filePath}.tmp` let two concurrent persists write the
    // same scratch path and rename a half-overwritten file into place.
    const tmp = `${this.filePath}.${process.pid}.${nextTmpSeq++}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.vectors)));
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      // A unique temp name is no longer self-limiting the way the old fixed `${file}.tmp` was
      // (the next persist overwrote it), so a failed write must clean up after itself or every
      // interruption leaves another full-size orphan next to the cache.
      await fs.rm(tmp, { force: true });
      throw err;
    }
    this.dirty = false;
  }
}
