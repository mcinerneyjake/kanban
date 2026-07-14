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

// Resolve chunk options from env (CHUNK_SIZE / CHUNK_OVERLAP). Invalid/non-integer values fall back rather than throw; chunkText is the single place that validates the (size, overlap) relationship.
export function resolveChunkConfig(env: NodeJS.ProcessEnv = process.env): ChunkOptions {
  return {
    size: intFromEnv(env.CHUNK_SIZE, DEFAULT_CHUNK_SIZE),
    overlap: intFromEnv(env.CHUNK_OVERLAP, DEFAULT_CHUNK_OVERLAP),
  };
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}
