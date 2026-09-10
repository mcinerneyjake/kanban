import { type EmbedConfig, resolveEmbedConfig } from './models.js';
import { chunkText, type ChunkOptions } from './chunk.js';
import { UsageMeter, type RunUsage, type CallTokens } from '../cost/usage.js';
import { RuntimeUnavailableError, UNAVAILABLE_STATUS } from '../runtime/unavailable.js';

// Retrieval layer (RAG): an `Embedder` seam + an in-memory cosine index over the board. Provider access is the OpenAI-compatible /v1/embeddings endpoint via fetch, no SDK.

// Provider-agnostic embedding seam. Documents and queries embed via separate methods because some models prefix the query (or both sides) with a task instruction — see models.ts.
export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  // Optional: prove the configured model is served, without embedding anything. A decorator that can
  // serve vectors WITHOUT calling embedDocuments must call this, or it skips the check entirely
  // (tkt-29f830c3466f). Optional so non-runtime embedders — stubs, fakes — need no preflight.
  verifyModel?(): Promise<void>;
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

// Ids from a /v1/models payload, or null when the reply is unusable. Entries WITHOUT a string `id` are
// skipped rather than failing the whole list (llm.ts:listModelIds does the same): one cosmetic entry
// from a proxy must not hard-block embedding when the configured model is right there beside it.
function modelIdsOf(v: unknown): string[] | null {
  if (typeof v !== 'object' || v === null || !('data' in v) || !Array.isArray(v.data)) return null;
  return v.data.flatMap((m: unknown) =>
    typeof m === 'object' && m !== null && 'id' in m && typeof m.id === 'string' ? [m.id] : []);
}

// Usage is optional + best-effort (embeddings report prompt/total, no completion); omit when absent/malformed so it never breaks the response.
// A reported 0 is treated as UNREPORTED (return undefined), NOT a measured zero: a non-empty embedding
// input can never genuinely be 0 tokens, and LM Studio's /v1/embeddings returns `prompt_tokens: 0`
// precisely because it doesn't count them. Counting that as a measured zero would tag a figure the
// runtime never produced as `measured` — the exact error the cost epic (tkt-88b47600d94c) forbids, and
// the reason a full run's embedding work logged as 0 tokens (tkt-78eedf738778). The compute is still
// metered via activeMs + the T1 call trace's inputChars; only the (unavailable) token count is dropped.
function embedUsageOf(v: unknown): CallTokens | undefined {
  if (typeof v !== 'object' || v === null || !('usage' in v)) return undefined;
  const u = v.usage;
  if (typeof u !== 'object' || u === null) return undefined;
  if (!('prompt_tokens' in u) || typeof u.prompt_tokens !== 'number' || u.prompt_tokens === 0) return undefined;
  const total = 'total_tokens' in u && typeof u.total_tokens === 'number' ? u.total_tokens : u.prompt_tokens;
  return { prompt: u.prompt_tokens, completion: 0, total };
}

// Local embedding servers cap inputs/tokens per request — embed in batches.
const EMBED_BATCH_SIZE = 64;
// Fail fast instead of hanging if the runtime is down or a model is still loading.
const EMBED_TIMEOUT_MS = 30_000;
// The model-list GET is a liveness-shaped probe, so it fails far faster than a generation request —
// same split, and the same reasoning, as llm.ts's PING_TIMEOUT_MS. Sharing EMBED_TIMEOUT_MS would put
// a hung runtime 60s away from the caller (30s listing + 30s embedding) instead of 35s.
const MODELS_TIMEOUT_MS = 5_000;

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

  // A runtime that does not serve `cfg.model` answers 200 and silently substitutes a different model,
  // so `res.ok` cannot distinguish a correct run from a wrong one. Measured against LM Studio on
  // 2026-09-09: `qwen3-embedding:0.6b` and `no-such-model-xyz` both returned 200 with 768-d nomic
  // vectors instead of 1024-d qwen3 (tkt-01b784eb0030).
  //
  // What this check proves is NARROW, and the narrowness is the honest part: GET /models lists every
  // DOWNLOADED model, loaded or not (measured 2026-07-27, llm.ts:249), so presence does not prove
  // residency and absence is the only thing it can positively catch. That is exactly the measured
  // incident — an id spelling this runtime never advertises. Residency is caught after the fact by
  // assertServedModel() below, off the response's own `model` field.
  //
  // Only a FULFILLED check is memoized. Memoizing a rejection would turn a runtime blip during the
  // first search into a permanent outage: indexCache.sharedEmbedder() holds one embedder for the life
  // of the process and no production path resets it, so every later call would keep replaying a
  // failure the runtime had long recovered from. Re-probing still fails closed for the call in hand.
  private servedCheck: Promise<void> | null = null;

  // On the seam so a caching decorator can run the preflight on a path that embeds nothing.
  verifyModel(): Promise<void> {
    return this.ensureModelServed();
  }

  private ensureModelServed(): Promise<void> {
    this.servedCheck ??= this.verifyModelServed().catch((err: unknown) => {
      this.servedCheck = null;
      throw err;
    });
    return this.servedCheck;
  }

  private async verifyModelServed(): Promise<void> {
    const served = await this.listServedModels();
    if (!served.includes(this.cfg.model)) {
      // A plain Error, deliberately NOT RuntimeUnavailableError. An id missing from the list is a
      // CONFIG fault (typo, never downloaded), not evidence the runtime is down — unavailable.ts is
      // explicit that recognition must be positive. llm.ts's own analogue is preflight(), which
      // likewise reports "fix your .env" rather than claiming unavailability; looksUnloaded() is a
      // different case (a 4xx body from a runtime that IS serving). Landing this on the 500 path is
      // also what gets the message below into the server log, where an operator can act on it —
      // a 503 is answered in the UI with "is the model running?" and logged nowhere.
      throw new Error(
        `Embedding model "${this.cfg.model}" is not served by the runtime at ${this.cfg.baseUrl}. `
        + 'That runtime answers 200 for an unknown model id and silently substitutes a different one, '
        + 'so continuing would produce plausible-looking vectors from the wrong model. '
        + `Served models: ${served.join(', ') || '(none)'}. Set EMBED_MODEL to one of these.`,
      );
    }
  }

  // Every failure path here THROWS: "could not determine the served set" is a refusal to embed, never
  // permission to proceed. A guard that fails open is worse than no guard, because it reports success.
  private async listServedModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/models`, { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new RuntimeUnavailableError(`Model list request timed out after ${MODELS_TIMEOUT_MS}ms — is the runtime at ${this.cfg.baseUrl} up?`, { cause: err });
      }
      // Not classified here: `cause` carries the connection code, and isRuntimeUnavailable walks the chain.
      throw new Error(`Could not list models at ${this.cfg.baseUrl} to verify "${this.cfg.model}" — refusing to embed.`, { cause: err });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      // Gateway-class only, matching llm.ts exactly: a 502/503/504 is the runtime (or a proxy) declining
      // to serve. A 404 — the shape EMBED_BASE_URL missing its /v1 suffix produces — is a FAULT, and
      // must stay on the 500 path so its body reaches the log instead of becoming "is the model running?".
      if (UNAVAILABLE_STATUS.has(res.status)) {
        throw new RuntimeUnavailableError(`Could not list models at ${this.cfg.baseUrl} to verify "${this.cfg.model}" — refusing to embed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
      }
      throw new Error(`Could not list models at ${this.cfg.baseUrl} to verify "${this.cfg.model}" — refusing to embed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
    const ids = modelIdsOf(await res.json().catch(() => null));
    if (ids === null) {
      // Deliberately NOT RuntimeUnavailableError: a reply we cannot parse is no positive evidence the
      // runtime is down, and unavailable.ts is explicit that an unrecognised failure must not claim it is.
      throw new Error(`Could not list models at ${this.cfg.baseUrl} to verify "${this.cfg.model}" — refusing to embed: unexpected /v1/models response shape`);
    }
    return ids;
  }

  // The list check above cannot see residency; this can. OpenAI-compatible /v1/embeddings echoes the
  // model that actually ran, which is the one piece of POSITIVE, post-hoc evidence about the vectors in
  // hand — and it is exactly what the measured substitution changes (requesting an unserved id came back
  // `served-as` nomic). A runtime that omits the field leaves us with the list check alone; that is a
  // real limit, so it is stated rather than papered over with a stricter-sounding guarantee.
  private assertServedModel(json: unknown): void {
    if (typeof json !== 'object' || json === null || !('model' in json)) return;
    const served = json.model;
    if (typeof served !== 'string' || served === this.cfg.model) return;
    throw new Error(
      `Embeddings ran on "${served}" but "${this.cfg.model}" was requested (${this.cfg.baseUrl}). `
      + 'The runtime substituted a different model, so these vectors are not comparable to any other '
      + 'run of this model — refusing them. Set EMBED_MODEL to a model the runtime actually serves.',
    );
  }

  private async postBatch(inputs: string[]): Promise<number[][]> {
    await this.ensureModelServed();
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
    this.assertServedModel(json);
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
        throw new Error(`Embeddings request timed out after ${EMBED_TIMEOUT_MS}ms — is the runtime at ${this.cfg.baseUrl} up?`, { cause: err });
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

  // Distinct document ids in the corpus. Exposed so a caller can prove an id is present BEFORE
  // searching for it: an absent id is unrankable, which reads as a retrieval miss and silently caps
  // any recall metric (tkt-0a076c4d3084).
  get documentIds(): Set<string> {
    return new Set(this.entries.map((e) => e.doc.id));
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
