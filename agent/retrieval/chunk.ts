// Splits long text into overlapping windows so a document embeds as several vectors and retrieval matches the one relevant passage, not a blurred average. Windows are CHARACTER-based, not token-based (deterministic, tokenizer-free; ~4 chars ≈ 1 token). Overlap carries context across a cut.

export interface ChunkOptions {
  /** Max characters per chunk. */
  size: number;
  /** Characters shared between consecutive chunks (0 = none). Must be < size. */
  overlap: number;
}

export const DEFAULT_CHUNK_SIZE = 1200;
export const DEFAULT_CHUNK_OVERLAP = 200;

// Split into overlapping chunks. Whitespace-only → []; fits-in-one-window → a single trimmed chunk; else a sliding window advancing by `size - overlap`.
export function chunkText(text: string, opts: ChunkOptions): string[] {
  const { size, overlap } = opts;
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error(`chunk overlap must be an integer in [0, size); got ${overlap} for size ${size}`);
  }

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= size) return [trimmed];

  const step = size - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < trimmed.length; start += step) {
    chunks.push(trimmed.slice(start, start + size));
    if (start + size >= trimmed.length) break;
  }
  return chunks;
}

// NOTE: there is deliberately no env-config layer (a former resolveChunkConfig reading
// CHUNK_SIZE / CHUNK_OVERLAP) — it was removed by tkt-3e5cde5af6a4. An A/B over the T2 golden set
// showed chunking gives the short-ticket board NO recall gain (recall@1/@5 identical) and slightly
// worse MRR (0.917 → 0.910) at ~3× the vectors, so the board indexes whole-ticket (no chunk options).
// `chunkText` + `DocumentIndex`'s optional `chunk` param remain as a per-connector capability: a
// future long/multi-topic source (SOP, email) passes explicit ChunkOptions where chunking earns its keep.
