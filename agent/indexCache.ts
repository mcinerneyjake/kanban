import { type Ticket } from '../shared/constants.js';
import { RuntimeEmbedder, DocumentIndex, type Embedder } from './retrieval.js';
import { resolveEmbedConfig } from './models.js';
import { TicketConnector } from './connectors/ticket.js';
import { EmbeddingStore } from './embeddingStore.js';
import { CachingEmbedder } from './cachingEmbedder.js';

// ---------------------------------------------------------------------------
// Process-wide cached DocumentIndex for the HTTP intake endpoints. Two caching
// layers stack here:
//   1. In-memory index memoization (this file): a signature over ticket
//      id + updated stamps, so an unchanged board reuses the built index and a
//      change rebuilds it. Fast, but process-local and lost on restart.
//   2. Persistent embedding cache (EmbeddingStore + CachingEmbedder): when
//      EMBED_CACHE_PATH is set, embeddings are keyed by content hash and stored
//      on disk. A rebuild then re-embeds only new/changed content, and a warm
//      restart re-embeds nothing — the vectors survive the process.
//
// This addresses the pain points previously flagged here: full re-embed on any
// change (now incremental) and re-embedding the world on every boot (now served
// from disk). Persistence is opt-in via EMBED_CACHE_PATH so zero-config still
// works purely in memory. Remaining cloud-migration note: RuntimeEmbedder sends
// no auth header; a cloud embedder needs an EMBED_API_KEY bearer, and the JSON
// store would move to a binary/SQLite column store at large scale.
// ---------------------------------------------------------------------------

// The board's connector — the one place that knows tickets. All ticket→Document
// mapping (and the board read) goes through it, keeping this module's caching
// concerns separate from source-schema knowledge.
const board = new TicketConnector();

// Lazily-loaded persistent embedding cache, keyed by its path. Loaded once per
// process (a change of path — only in tests — reloads). Returns null when no
// path is configured, so the index runs purely in memory.
let storeCache: { path: string; store: Promise<EmbeddingStore> } | null = null;
function embeddingStore(cachePath?: string): Promise<EmbeddingStore> | null {
  const p = cachePath ?? process.env.EMBED_CACHE_PATH;
  if (!p) return null;
  if (!storeCache || storeCache.path !== p) {
    storeCache = { path: p, store: EmbeddingStore.load(p) };
  }
  return storeCache.store;
}

// Build a fresh (uncached) index over a board. The CLIs (agent/searchDemo) run
// once and don't benefit from the process cache, so they build directly. Pass
// `tickets` to skip the board read (tests); otherwise the connector pulls it.
export async function buildBoardIndex(embedder: Embedder, tickets?: Ticket[]): Promise<DocumentIndex> {
  const all = tickets ?? await board.pull();
  return DocumentIndex.build(embedder, all.map((t) => board.toDocument(t)));
}

function signature(tickets: Ticket[]): string {
  return tickets.map((t) => `${t.id}:${t.updated}`).sort().join('|');
}

interface Cached { index: DocumentIndex; sig: string }
let cache: Cached | null = null;
// In-flight build shared by concurrent callers, so the boot warm and an early
// request don't race into duplicate embedding passes. Coalesces by presence,
// not by signature — a board change mid-build is picked up on the next call.
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
  // Pull raw tickets first: the change signature is computed over their
  // id + updated stamps, then each is mapped to a Document via the connector.
  const tickets = opts.tickets ?? await board.pull();
  const sig = signature(tickets);
  if (cache && cache.sig === sig) return cache.index;

  const raw = opts.embedder ?? RuntimeEmbedder.fromEnv();
  const documents = tickets.map((t) => board.toDocument(t));
  const store = await (embeddingStore(opts.cachePath) ?? Promise.resolve(null));

  // With a persistent store, embed through the cache (only new/changed content
  // hits the model), then prune to the current corpus and flush to disk. Without
  // one, embed directly — pure in-memory, unchanged behavior.
  if (store) {
    // Namespace the cache by the embedder's identity so a model/prefix swap
    // re-embeds rather than serving stale (possibly wrong-dimension) vectors.
    const caching = new CachingEmbedder(raw, store, cacheNamespace());
    const index = await DocumentIndex.build(caching, documents);
    // Prune to the current corpus to bound growth — but NOT when the corpus is
    // empty: a transiently unreadable/empty board must not wipe the whole cache
    // and force a cold re-embed of everything on the next real build.
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

// The embedder's cache identity: model + document-instruction prefix, the two
// config fields that change a document vector for the same text.
function cacheNamespace(): string {
  const cfg = resolveEmbedConfig();
  return `${cfg.model} ${cfg.docInstruction}`;
}

// Return a DocumentIndex for the current board, rebuilding only when the board
// has changed. Concurrent calls share a single in-flight build.
export function getTicketIndex(opts: IndexOptions = {}): Promise<DocumentIndex> {
  if (pending) return pending;
  const p = buildIndex(opts).finally(() => { if (pending === p) pending = null; });
  pending = p;
  return p;
}

// Test hook — drop the cached index, any in-flight build, and the loaded
// embedding store. Clearing the store forces the next build to reload it from
// disk, which is how a test simulates a process restart.
export function resetIndexCache(): void {
  cache = null;
  pending = null;
  storeCache = null;
}
