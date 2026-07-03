import { type Document } from '../retrieval.js';

// ---------------------------------------------------------------------------
// Connector contract (Phase 1). A Connector is a source of documents for the
// retrieval index: it knows how to pull its own raw records and map each one to
// the generic `Document` shape. It is the ONE place per source that understands
// that source's schema — everything downstream (DocumentIndex, search, the
// agent) is source-agnostic. Each concrete source lives in its own sibling file
// (ticket.ts, and future docs.ts / email.ts / …) and implements this interface.
//
// Generic over the raw record type `R` so `toDocument` stays type-safe without
// casts — a shared `SourceRecord` base type would have to widen to `unknown`
// and lose that safety, so we parameterize instead.
// ---------------------------------------------------------------------------

export interface Connector<R> {
  /** Stable id for this source; becomes each produced Document's `source`. */
  readonly source: string;
  /** Fetch the current raw records from the source. */
  pull(): Promise<R[]>;
  /** Map one raw record to a Document. */
  toDocument(record: R): Document;
}

// Pull + map in one pass — the common path when (re)building an index.
export async function collectDocuments<R>(connector: Connector<R>): Promise<Document[]> {
  const records = await connector.pull();
  return records.map((r) => connector.toDocument(r));
}
