import { type EmbedConfig, resolveEmbedConfig } from './models.js';
import { chunkText, type ChunkOptions } from './chunk.js';
import { UsageMeter, type RunUsage, type CallTokens } from '../cost/usage.js';

// Retrieval layer (RAG): an `Embedder` seam + an in-memory cosine index over the board. Provider access is the OpenAI-compatible /v1/embeddings endpoint via fetch, no SDK.

// Provider-agnostic embedding seam. Documents and queries embed via separate methods because some models prefix the query (or both sides) with a task instruction — see models.ts.
export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

// --- OpenAI-compatible runtime embedder ------------------------------------
// Response shape is validated with type predicates (no casts) at the boundary.

interface EmbeddingDatum { embedding: number[]; index: number }
interface EmbeddingResponse { data: EmbeddingDatum[] }

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number');
}
function isEmbeddingDatum(v: unknown): v is EmbeddingDatum {
  return typeof v === 'object' && v !== null
    && 'embedding' in v && isNumberArray(v.embedding)
    && 'index' in v && typeof v.index === 'number';
}
function isEmbeddingResponse(v: unknown): v is EmbeddingResponse {
  return typeof v === 'object' && v !== null
    && 'data' in v && Array.isArray(v.data) && v.data.every(isEmbeddingDatum);
}

// Usage is optional + best-effort (embeddings report prompt/total, no completion); omit when absent/malformed so it never breaks the response.
function embedUsageOf(v: unknown): CallTokens | undefined {
  if (typeof v !== 'object' || v === null || !('usage' in v)) return undefined;
  const u = v.usage;
  if (typeof u !== 'object' || u === null) return undefined;
  if (!('prompt_tokens' in u) || typeof u.prompt_tokens !== 'number') return undefined;
  const total = 'total_tokens' in u && typeof u.total_tokens === 'number' ? u.total_tokens : u.prompt_tokens;
  return { prompt: u.prompt_tokens, completion: 0, total };
}

// Local embedding servers cap inputs/tokens per request — embed in batches.
const EMBED_BATCH_SIZE = 64;
// Fail fast instead of hanging if the runtime is down or a model is still loading.
const EMBED_TIMEOUT_MS = 30_000;

export class RuntimeEmbedder implements Embedder {
  private readonly meter = new UsageMeter();

  // `now` is injectable so call durations are deterministic under test.
  constructor(
    private readonly cfg: EmbedConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEmbedder {
    return new RuntimeEmbedder(resolveEmbedConfig(env));
  }

  // Accumulated usage over this embedder's lifetime. Tokens are "available" only if reportedCalls > 0.
  getUsage(): RunUsage {
    return this.meter.get();
  }

  private async post(inputs: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
      out.push(...await this.postBatch(inputs.slice(i, i + EMBED_BATCH_SIZE)));
    }
    return out;
  }

  private async postBatch(inputs: string[]): Promise<number[][]> {
    const start = this.now();
    const res = await this.fetchEmbeddings(inputs);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Embeddings request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
    const json: unknown = await res.json();
    if (!isEmbeddingResponse(json)) {
      throw new Error('Unexpected /v1/embeddings response shape');
    }
    this.meter.record({
      kind: 'embed',
      startedAt: start,
      elapsedMs: this.now() - start,
      inputChars: inputs.reduce((n, s) => n + s.length, 0),
      tokens: embedUsageOf(json),
    });
    // The API may return data out of input order; sort by index to realign.
    return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  private async fetchEmbeddings(inputs: string[]): Promise<Response> {
    try {
      return await fetch(`${this.cfg.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.cfg.model, input: inputs }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`Embeddings request timed out after ${EMBED_TIMEOUT_MS}ms — is the runtime at ${this.cfg.baseUrl} up?`);
      }
      throw err;
    }
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.post(texts.map((t) => `${this.cfg.docInstruction}${t}`));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.post([`${this.cfg.queryInstruction}${text}`]);
    if (!vec) throw new Error('Embedder returned no vector for the query');
    return vec;
  }
}

// --- cosine similarity ------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- document model + in-memory index --------------------------------------

// A source-agnostic unit of retrieval. Connectors map their records to this shape; the index embeds `text`. `meta` carries source-specific extras (e.g. a ticket's status) without leaking field names into this generic model.
export interface Document {
  id: string;
  source: string;                 // connector the document came from, e.g. 'ticket'
  title: string;
  text: string;                   // the embeddable content (title + body, a chunk, …)
  url?: string;
  updated?: string;
  meta?: Record<string, string>;
}

// A search hit: identity + score (`text` dropped, `meta` carried through). `chunk` is present only on non-rolled-up results — which chunk of the parent matched, and its text.
export interface ScoredDocument {
  id: string;
  source: string;
  title: string;
  url?: string;
  score: number;
  meta?: Record<string, string>;
  chunk?: { index: number; text: string };
}

const DEFAULT_TOP_K = 5;

// One embedded unit: the `chunkIndex`-th chunk of parent `doc` (chunking off ⇒ one entry per doc, index 0). Chunk text is NOT stored — re-derived from doc.text on the rare rollup:false path, so the index doesn't duplicate text in memory.
interface Entry {
  doc: Document;
  chunkIndex: number;
  vector: number[];
}

export class DocumentIndex {
  private entries: Entry[] = [];

  // `chunk` splits each document's text into multiple vectors; omit to index each document as a single vector (the default).
  constructor(
    private readonly embedder: Embedder,
    private readonly chunk?: ChunkOptions,
  ) {}

  static async build(embedder: Embedder, documents: Document[], chunk?: ChunkOptions): Promise<DocumentIndex> {
    const index = new DocumentIndex(embedder, chunk);
    await index.rebuild(documents);
    return index;
  }

  // Embeddable units — chunks (chunking on) or the whole trimmed text. Empty/whitespace text yields NO units in EITHER mode, so such a doc is consistently absent (the no-chunk path must match chunkText, or the same record would index off but drop on).
  private unitsOf(doc: Document): string[] {
    if (this.chunk) return chunkText(doc.text, this.chunk);
    const trimmed = doc.text.trim();
    return trimmed ? [trimmed] : [];
  }

  // (Re)embed the corpus, replacing prior contents. Each document is exploded into chunks (keyed back to their parent) before embedding.
  async rebuild(documents: Document[]): Promise<void> {
    const pending = documents.flatMap((doc) =>
      this.unitsOf(doc).map((text, chunkIndex) => ({ doc, chunkIndex, text })),
    );
    const vectors = await this.embedder.embedDocuments(pending.map((p) => p.text));
    if (vectors.length !== pending.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${pending.length} chunks`);
    }
    // Keep only (doc, chunkIndex, vector) — chunk text is re-derivable, so it's dropped rather than retained.
    this.entries = pending.map((p, i) => ({ doc: p.doc, chunkIndex: p.chunkIndex, vector: vectors[i] }));
  }

  // Number of indexed chunks — equals the document count when chunking is off.
  get size(): number {
    return this.entries.length;
  }

  // Semantic top-k by cosine similarity. Default rolls up to the best-scoring chunk per parent document (the shape every consumer expects); `{ rollup: false }` returns per-chunk hits with the matched chunk's index + text.
  async search(query: string, k: number = DEFAULT_TOP_K, opts: { rollup?: boolean } = {}): Promise<ScoredDocument[]> {
    if (this.entries.length === 0) return [];
    const q = await this.embedder.embedQuery(query);
    const rollup = opts.rollup ?? true;
    const scored = this.entries.map((e) => ({ entry: e, score: cosineSimilarity(q, e.vector) }));
    const hits = rollup ? bestChunkPerDocument(scored) : scored;
    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k))
      .map(({ entry, score }) => this.toScored(entry, score, rollup));
  }

  // Rolled-up hit = parent identity + score. Chunk-level hit also attaches the matched chunk's index + text, re-derived from the parent (unitsOf is deterministic) rather than stored per entry.
  private toScored(entry: Entry, score: number, rolledUp: boolean): ScoredDocument {
    const { doc, chunkIndex } = entry;
    const base: ScoredDocument = {
      id: doc.id,
      source: doc.source,
      title: doc.title,
      url: doc.url,
      score,
      meta: doc.meta,
    };
    if (rolledUp) return base;
    return { ...base, chunk: { index: chunkIndex, text: this.unitsOf(doc)[chunkIndex] ?? '' } };
  }
}

type ScoredEntry = { entry: Entry; score: number };

// Collapse chunk hits to one per parent, keeping the best score. Grouped by the document OBJECT (not its id) so ids may collide across sources without being merged.
function bestChunkPerDocument(scored: ScoredEntry[]): ScoredEntry[] {
  const best = new Map<Document, ScoredEntry>();
  for (const s of scored) {
    const cur = best.get(s.entry.doc);
    if (!cur || s.score > cur.score) best.set(s.entry.doc, s);
  }
  return [...best.values()];
}
