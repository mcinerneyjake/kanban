import { type EmbedConfig, resolveEmbedConfig } from './models.js';
import { UsageMeter, type RunUsage, type CallTokens } from './usage.js';

// ---------------------------------------------------------------------------
// Retrieval layer (RAG) — Phase 1 of the agent. An `Embedder` seam plus an
// in-memory cosine index over the board. Provider access is the OpenAI-
// compatible /v1/embeddings endpoint via fetch — no SDK dependency (the openai
// SDK lands with the chat loop in Phase 3).
// ---------------------------------------------------------------------------

// Provider-agnostic embedding seam. Documents and queries are embedded via
// separate methods because some models prefix the query (or both sides) with a
// task instruction — see models.ts.
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

// Embedding usage is optional + best-effort (embeddings report prompt/total, no
// completion); omit when absent or malformed so it never breaks the response.
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

  // Accumulated embedding usage + active-compute time over this embedder's
  // lifetime. Tokens are "available" only if reportedCalls > 0.
  getUsage(): RunUsage {
    return this.meter.get();
  }

  // Embed inputs in batches, concatenating results in input order.
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
    // Record the batch's duration + token usage (when the runtime reported it).
    this.meter.record(this.now() - start, embedUsageOf(json));
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

// A source-agnostic unit of retrieval. Connectors (tickets, docs, email, …) map
// their own records to this shape; the index embeds `text` and grounds over it.
// `meta` carries source-specific extras (e.g. a ticket's status) through to
// search results without leaking those field names into this generic model.
export interface Document {
  id: string;
  source: string;                 // connector the document came from, e.g. 'ticket'
  title: string;
  text: string;                   // the embeddable content (title + body, a chunk, …)
  url?: string;
  updated?: string;
  meta?: Record<string, string>;
}

// A search hit: the document's identity + relevance score. `text` is dropped
// (callers rank/display by title); `meta` is carried through from the document.
export interface ScoredDocument {
  id: string;
  source: string;
  title: string;
  url?: string;
  score: number;
  meta?: Record<string, string>;
}

const DEFAULT_TOP_K = 5;

export class DocumentIndex {
  private entries: { doc: Document; vector: number[] }[] = [];

  constructor(private readonly embedder: Embedder) {}

  static async build(embedder: Embedder, documents: Document[]): Promise<DocumentIndex> {
    const index = new DocumentIndex(embedder);
    await index.rebuild(documents);
    return index;
  }

  // (Re)embed the given corpus into the in-memory index, replacing any prior
  // contents. The caller owns the source→Document mapping (see the connectors).
  async rebuild(documents: Document[]): Promise<void> {
    const vectors = await this.embedder.embedDocuments(documents.map((d) => d.text));
    if (vectors.length !== documents.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${documents.length} documents`);
    }
    this.entries = documents.map((doc, i) => ({ doc, vector: vectors[i] }));
  }

  get size(): number {
    return this.entries.length;
  }

  // Semantic top-k by cosine similarity to the query.
  async search(query: string, k: number = DEFAULT_TOP_K): Promise<ScoredDocument[]> {
    if (this.entries.length === 0) return [];
    const q = await this.embedder.embedQuery(query);
    return this.entries
      .map(({ doc, vector }) => ({
        id: doc.id,
        source: doc.source,
        title: doc.title,
        url: doc.url,
        score: cosineSimilarity(q, vector),
        meta: doc.meta,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }
}
