import path from 'node:path';
import { type Ticket } from '../../shared/constants.js';
import { getTicketsDir } from '../../server/tickets.js';
import { RuntimeEmbedder, DocumentIndex, type Embedder } from './retrieval.js';
import { resolveEmbedConfig } from './models.js';
import { TicketConnector } from './connectors/ticket.js';
import { EmbeddingStore } from './embeddingStore.js';
import { CachingEmbedder } from './cachingEmbedder.js';

// Process-wide cached DocumentIndex for the HTTP intake endpoints. Two caching layers stack: (1) in-memory index memoization keyed by an id+updated signature (process-local, lost on restart); (2) persistent embedding cache (EmbeddingStore + CachingEmbedder), opt-in via EMBED_CACHE_PATH — a rebuild re-embeds only new/changed content, a warm restart re-embeds nothing. A cloud embedder would need an EMBED_API_KEY bearer + a SQLite store at scale.

// The board's connector — the one place that knows tickets, keeping caching concerns separate from source-schema knowledge.
const board = new TicketConnector();

// Lazily-loaded persistent embedding cache, keyed by path (a path change — tests only — reloads). Null when no path configured, so the index runs purely in memory.
let storeCache: { path: string; store: Promise<EmbeddingStore> } | null = null;
function embeddingStore(cachePath?: string): Promise<EmbeddingStore> | null {
  const p = cachePath ?? process.env.EMBED_CACHE_PATH;
  if (!p) return null;
  if (!storeCache || storeCache.path !== p) {
    storeCache = { path: p, store: EmbeddingStore.load(p) };
  }
  return storeCache.store;
}

// Fresh (uncached) index — pass `tickets` to skip the board read (tests). Kept as the pure building
// block; the CLIs use buildCliIndex (below) for persistent caching.
// Whole-ticket embedding (no ChunkOptions) is a MEASURED decision, not an oversight (tkt-3e5cde5af6a4):
// an A/B over the T2 golden set found chunking gives this short-ticket corpus no recall gain and
// slightly worse MRR at ~3× the vectors. Chunking stays available per-connector for long-doc sources.
export async function buildBoardIndex(embedder: Embedder, tickets?: Ticket[]): Promise<DocumentIndex> {
  const all = tickets ?? await board.pull();
  return DocumentIndex.build(embedder, all.map((t) => board.toDocument(t)));
}

// Zero-config cache location: <boardRoot>/.cache/embeddings.json. Absolute + override-aware
// (getTicketsDir honors BOARD_DIR_OVERRIDE), so every one-shot CLI shares ONE cache regardless of cwd —
// a relative path would resolve against each process's cwd and diverge. `.cache/` is gitignored.
export function defaultCachePath(): string {
  return path.join(getTicketsDir(), '..', '.cache', 'embeddings.json');
}

// The CLI index build. One-shot CLIs get no benefit from the in-memory memo, but the persistent
// EmbeddingStore turns a cold ~65s full re-embed into a warm run that re-embeds only changed tickets
// (tkt-a74040f7cbed). Zero-config by default; EMBED_CACHE_PATH still overrides. The long-running server
// keeps its opt-in caching (getTicketIndex with no cachePath) unchanged — this default is CLI-only.
export function buildCliIndex(embedder: Embedder): Promise<DocumentIndex> {
  return getTicketIndex({ embedder, cachePath: process.env.EMBED_CACHE_PATH ?? defaultCachePath() });
}

function signature(tickets: Ticket[]): string {
  return tickets.map((t) => `${t.id}:${t.updated}`).sort().join('|');
}

interface Cached { index: DocumentIndex; sig: string }
let cache: Cached | null = null;
// In-flight build shared by concurrent callers so they don't race into duplicate embedding passes. Coalesces by presence, not signature — a mid-build board change is picked up on the next call.
let pending: Promise<DocumentIndex> | null = null;

export interface IndexOptions {
  /** Override the embedder (tests inject a stub). */
  embedder?: Embedder;
  /** Provide tickets directly to skip the filesystem read (tests). */
  tickets?: Ticket[];
  /** Persistent embedding-cache path; overrides EMBED_CACHE_PATH (tests). */
  cachePath?: string;
}

async function buildIndex(opts: IndexOptions): Promise<DocumentIndex> {
  // Pull raw tickets first — the change signature is over their id + updated stamps, before mapping to Documents.
  const tickets = opts.tickets ?? await board.pull();
  const sig = signature(tickets);
  if (cache && cache.sig === sig) return cache.index;

  const raw = opts.embedder ?? RuntimeEmbedder.fromEnv();
  const documents = tickets.map((t) => board.toDocument(t));
  const store = await (embeddingStore(opts.cachePath) ?? Promise.resolve(null));

  // With a persistent store, embed through the cache then prune + flush; without one, embed directly (pure in-memory).
  if (store) {
    // Namespace by the embedder's identity so a model/prefix swap re-embeds rather than serving stale vectors.
    const caching = new CachingEmbedder(raw, store, cacheNamespace());
    const index = await DocumentIndex.build(caching, documents);
    // Prune to bound growth — but NOT when the corpus is empty: a transiently unreadable board must not wipe the cache and force a cold re-embed next build.
    const keep = caching.corpusHashes();
    if (keep.size > 0) store.prune(keep);
    await store.persist();
    cache = { index, sig };
    return index;
  }

  const index = await DocumentIndex.build(raw, documents);
  cache = { index, sig };
  return index;
}

// The embedder's cache identity: model + doc-instruction prefix — the two fields that change a document vector for the same text.
function cacheNamespace(): string {
  const cfg = resolveEmbedConfig();
  return `${cfg.model} ${cfg.docInstruction}`;
}

// DocumentIndex for the current board, rebuilding only on change. Concurrent calls share one in-flight build.
export function getTicketIndex(opts: IndexOptions = {}): Promise<DocumentIndex> {
  if (pending) return pending;
  const p = buildIndex(opts).finally(() => { if (pending === p) pending = null; });
  pending = p;
  return p;
}

// Test hook — drop the cached index, in-flight build, and loaded store. Clearing the store forces a disk reload next build, simulating a process restart.
export function resetIndexCache(): void {
  cache = null;
  pending = null;
  storeCache = null;
}
