import { type Ticket } from '../shared/constants.js';
import { RuntimeEmbedder, DocumentIndex, type Embedder } from './retrieval.js';
import { TicketConnector } from './connectors/ticket.js';

// ---------------------------------------------------------------------------
// Process-wide cached TicketIndex for the HTTP intake endpoints. Building the
// index embeds the whole board, so we cache it and rebuild only when the board
// changes — detected by a signature over ticket ids + updated timestamps.
// (Full rebuild on any change is fine at demo scale; incremental re-embedding
// of only the changed tickets is a future optimization.)
//
// Cloud migration notes (pain points) — this cache is tuned for a LOCAL,
// single-process, keyless embedder. Moving embeddings to a cloud API
// (OpenAI/Voyage) turns cheap local assumptions costly:
//   1. The boot-time warm (server/index.ts) re-embeds the WHOLE board on every
//      start — free locally, but $ + rate-limit risk per boot in the cloud.
//   2. The index lives in process memory: it doesn't survive restarts and isn't
//      shared. Horizontally scaled / serverless => each instance warms
//      independently (N x cost + a per-instance cold start).
//   3. Full rebuild on ANY board change re-embeds everything — cheap locally,
//      costly per-change in the cloud.
//   4. RuntimeEmbedder sends no auth header; a cloud embedder needs an
//      EMBED_API_KEY bearer (the deferred cloud-embed-auth work).
// Cloud-ready shape: persist vectors (a vector store / DB), embed INCREMENTALLY
// (only changed tickets), and drop or gate the eager warm so you don't pay to
// re-embed on every boot.
// ---------------------------------------------------------------------------

// The board's connector — the one place that knows tickets. All ticket→Document
// mapping (and the board read) goes through it, keeping this module's caching
// concerns separate from source-schema knowledge.
const board = new TicketConnector();

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
}

async function buildIndex(opts: IndexOptions): Promise<DocumentIndex> {
  // Pull raw tickets first: the change signature is computed over their
  // id + updated stamps, then each is mapped to a Document via the connector.
  const tickets = opts.tickets ?? await board.pull();
  const sig = signature(tickets);
  if (cache && cache.sig === sig) return cache.index;
  const embedder = opts.embedder ?? RuntimeEmbedder.fromEnv();
  const index = await DocumentIndex.build(embedder, tickets.map((t) => board.toDocument(t)));
  cache = { index, sig };
  return index;
}

// Return a DocumentIndex for the current board, rebuilding only when the board
// has changed. Concurrent calls share a single in-flight build.
export function getTicketIndex(opts: IndexOptions = {}): Promise<DocumentIndex> {
  if (pending) return pending;
  const p = buildIndex(opts).finally(() => { if (pending === p) pending = null; });
  pending = p;
  return p;
}

// Test hook — drop the cached index + any in-flight build.
export function resetIndexCache(): void {
  cache = null;
  pending = null;
}
