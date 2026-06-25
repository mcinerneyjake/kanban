import { listTickets } from '../server/tickets.js';
import { type Ticket } from '../shared/constants.js';
import { RuntimeEmbedder, TicketIndex, type Embedder } from './retrieval.js';

// ---------------------------------------------------------------------------
// Process-wide cached TicketIndex for the HTTP intake endpoints. Building the
// index embeds the whole board, so we cache it and rebuild only when the board
// changes — detected by a signature over ticket ids + updated timestamps.
// (Full rebuild on any change is fine at demo scale; incremental re-embedding
// of only the changed tickets is a future optimization.)
// ---------------------------------------------------------------------------

function signature(tickets: Ticket[]): string {
  return tickets.map((t) => `${t.id}:${t.updated}`).sort().join('|');
}

interface Cached { index: TicketIndex; sig: string }
let cache: Cached | null = null;

export interface IndexOptions {
  /** Override the embedder (tests inject a stub). */
  embedder?: Embedder;
  /** Provide tickets directly to skip the filesystem read (tests). */
  tickets?: Ticket[];
}

// Return a TicketIndex for the current board, rebuilding only when the board has
// changed since the last build.
export async function getTicketIndex(opts: IndexOptions = {}): Promise<TicketIndex> {
  const tickets = opts.tickets ?? await listTickets();
  const sig = signature(tickets);
  if (cache && cache.sig === sig) return cache.index;
  const embedder = opts.embedder ?? RuntimeEmbedder.fromEnv();
  const index = await TicketIndex.build(embedder, tickets);
  cache = { index, sig };
  return index;
}

// Test hook — drop the cached index.
export function resetIndexCache(): void {
  cache = null;
}
