import { listTickets } from '../server/tickets.js';
import { type Ticket } from '../shared/constants.js';
import { type EmbedConfig, resolveEmbedConfig } from './models.js';

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

export class RuntimeEmbedder implements Embedder {
  constructor(private readonly cfg: EmbedConfig) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEmbedder {
    return new RuntimeEmbedder(resolveEmbedConfig(env));
  }

  private async post(inputs: string[]): Promise<number[][]> {
    const res = await fetch(`${this.cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, input: inputs }),
    });
    if (!res.ok) {
      throw new Error(`Embeddings request failed: ${res.status} ${res.statusText}`);
    }
    const json: unknown = await res.json();
    if (!isEmbeddingResponse(json)) {
      throw new Error('Unexpected /v1/embeddings response shape');
    }
    // The API may return data out of input order; sort by index to realign.
    return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
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

// --- in-memory ticket index -------------------------------------------------

export interface ScoredTicket { id: string; title: string; score: number }

const DEFAULT_TOP_K = 5;

// One embeddable document per ticket: title + body.
function docText(t: Ticket): string {
  return `${t.title}\n\n${t.body}`.trim();
}

export class TicketIndex {
  private entries: { id: string; title: string; vector: number[] }[] = [];

  constructor(private readonly embedder: Embedder) {}

  static async build(embedder: Embedder, tickets?: Ticket[]): Promise<TicketIndex> {
    const index = new TicketIndex(embedder);
    await index.rebuild(tickets);
    return index;
  }

  // (Re)embed the whole board into the in-memory index. Pass `tickets` to skip
  // the filesystem read (used by tests); otherwise reads the live board.
  async rebuild(tickets?: Ticket[]): Promise<void> {
    const all = tickets ?? await listTickets();
    const vectors = await this.embedder.embedDocuments(all.map(docText));
    if (vectors.length !== all.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${all.length} tickets`);
    }
    this.entries = all.map((t, i) => ({ id: t.id, title: t.title, vector: vectors[i] }));
  }

  get size(): number {
    return this.entries.length;
  }

  // Semantic top-k by cosine similarity to the query.
  async search(query: string, k: number = DEFAULT_TOP_K): Promise<ScoredTicket[]> {
    if (this.entries.length === 0) return [];
    const q = await this.embedder.embedQuery(query);
    return this.entries
      .map((e) => ({ id: e.id, title: e.title, score: cosineSimilarity(q, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }
}
