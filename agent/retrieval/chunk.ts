// ---------------------------------------------------------------------------
// Chunking. Tickets embed as one vector (title+body), but real source content
// (a 40-page SOP, a long mail thread) exceeds an embedder's context and blurs
// into one averaged vector. Splitting text into overlapping windows lets long
// documents embed as several vectors, so retrieval can match the one passage
// that's relevant instead of the whole document's blurred average.
//
// Windows are CHARACTER-based, not token-based: deterministic, tokenizer-free,
// and good enough locally — treat `size`/`overlap` as chars (~4 chars ≈ 1 token
// for English, so a 1200-char window ≈ 300 tokens). The overlap carries context
// across a cut so a sentence split mid-window is still wholly present in one
// neighbour.
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  /** Max characters per chunk. */
  size: number;
  /** Characters shared between consecutive chunks (0 = none). Must be < size. */
  overlap: number;
}

export const DEFAULT_CHUNK_SIZE = 1200;
export const DEFAULT_CHUNK_OVERLAP = 200;

// Split `text` into overlapping chunks. Whitespace-only text → []. Text that
// fits in one window → a single trimmed chunk. Otherwise a sliding window of
// `size` chars advancing by `size - overlap` until the text is covered.
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
    if (start + size >= trimmed.length) break; // last window reached the end
  }
  return chunks;
}

// Resolve chunk options from env (CHUNK_SIZE / CHUNK_OVERLAP), falling back to
// the defaults — mirrors the resolve*Config seams elsewhere in agent/. Invalid
// or non-integer values fall back rather than throwing here; chunkText is the
// single place that validates the resulting (size, overlap) relationship.
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
