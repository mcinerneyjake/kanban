import fs from 'node:fs/promises';
import path from 'node:path';
import { type Ticket } from '../../shared/constants.js';
import { getTicketsDir } from '../../server/tickets.js';
import { RuntimeEmbedder, DocumentIndex, type Embedder } from './retrieval.js';
import { resolveEmbedConfig } from './models.js';
import { TicketConnector } from './connectors/ticket.js';
import { EmbeddingStore } from './embeddingStore.js';
import { CachingEmbedder } from './cachingEmbedder.js';
import { emptyUsage, type RunUsage } from '../cost/usage.js';

// Process-wide cached DocumentIndex for the HTTP intake endpoints. Two caching layers stack: (1) in-memory index memoization keyed by an id+updated signature (process-local, lost on restart); (2) persistent embedding cache (EmbeddingStore + CachingEmbedder) — a rebuild re-embeds only new/changed content, a warm restart re-embeds nothing. A cloud embedder would need an EMBED_API_KEY bearer + a SQLite store at scale.

// The board's connector — the one place that knows tickets, keeping caching concerns separate from source-schema knowledge.
const board = new TicketConnector();

// One shared embedder per process so its usage meter survives across index builds — the
// intake controller reads a baseline/delta off it to charge a run for its embeds
// (tkt-9f09b3a1e95c). A per-build `RuntimeEmbedder.fromEnv()` reset the meter each time,
// which is why embeds were invisible to the run log.
let runtimeEmbedder: RuntimeEmbedder | null = null;
function sharedEmbedder(): RuntimeEmbedder {
  runtimeEmbedder ??= RuntimeEmbedder.fromEnv();
  return runtimeEmbedder;
}

// The shared embedder's cumulative usage. Read the RAW embedder, never the CachingEmbedder
// wrapper: a cache hit issues no runtime call and must not be metered as one.
export function embedUsage(): RunUsage {
  return runtimeEmbedder ? runtimeEmbedder.getUsage() : emptyUsage();
}

// Explicit path > EMBED_CACHE_PATH > the board default. Exported so the resolution order is
// asserted directly rather than inferred from embedding behaviour.
// `||`, not `??`: a BLANK EMBED_CACHE_PATH must fall through to the default. `??` would return
// '' — a path EmbeddingStore.load swallows but rename() rejects, turning every intake request
// into a 503. Blank now means "use the default"; there is no cache-free mode any more.
export function resolveCachePath(cachePath?: string): string {
  return cachePath || process.env.EMBED_CACHE_PATH || defaultCachePath();
}

async function fileMtime(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return 0; // absent (or unreadable) — treat as "no file yet", never throw on a cache probe
  }
}

// Lazily-loaded persistent embedding cache. Keyed by path AND mtime: the server and the CLI now
// share one file, so a long-running server holding its boot-time map would re-embed — and then
// overwrite — whatever a CLI run persisted in the meantime. Re-reading on mtime change costs a
// ~55ms parse (measured, tkt-a74040f7cbed) and only when another writer actually moved.
let storeCache: { path: string; mtimeMs: number; store: Promise<EmbeddingStore> } | null = null;
async function embeddingStore(cachePath?: string): Promise<EmbeddingStore> {
  const p = resolveCachePath(cachePath);
  const mtimeMs = await fileMtime(p);
  if (!storeCache || storeCache.path !== p || storeCache.mtimeMs !== mtimeMs) {
    storeCache = { path: p, mtimeMs, store: EmbeddingStore.load(p) };
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
// EmbeddingStore turns a cold full re-embed into a warm run that re-embeds only changed tickets
// (tkt-a74040f7cbed). Now identical to the server's default resolution — kept as a named entry
// point because the CLIs read better for it.
export function buildCliIndex(embedder: Embedder): Promise<DocumentIndex> {
  return getTicketIndex({ embedder });
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

  const raw = opts.embedder ?? sharedEmbedder();
  const documents = tickets.map((t) => board.toDocument(t));
  const store = await embeddingStore(opts.cachePath);

  // Namespace by the embedder's identity so a model/prefix swap re-embeds rather than serving stale vectors.
  const caching = new CachingEmbedder(raw, store, cacheNamespace());
  const index = await DocumentIndex.build(caching, documents);
  // Prune to bound growth — but NOT when the corpus is empty: a transiently unreadable board must not wipe the cache and force a cold re-embed next build.
  // Scoped to THIS embedder's namespace: another EMBED_MODEL's vectors live in the same file and are
  // not ours to delete (tkt-aa73a535ec4a).
  const keep = caching.corpusHashes();
  if (keep.size > 0) store.prune(keep, caching.scope());
  // Best-effort, like EmbeddingStore.load: the cache is an optimization, so an unwritable
  // .cache/ (read-only mount, EACCES, ENOSPC) must not take intake down with a 503. Before this
  // ticket the server path performed no disk writes at all, so no disk condition could break it.
  try {
    await store.persist();
    if (storeCache) storeCache.mtimeMs = await fileMtime(storeCache.path); // our own write isn't a foreign one
  } catch (err) {
    console.warn(`[intake] embedding cache not persisted: ${err instanceof Error ? err.message : String(err)}`);
  }
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

// Test hook — drop the cached index, in-flight build, loaded store, and shared embedder.
// Clearing the store forces a disk reload next build, simulating a process restart.
export function resetIndexCache(): void {
  cache = null;
  pending = null;
  storeCache = null;
  runtimeEmbedder = null;
}
