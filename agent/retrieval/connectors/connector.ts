import { type Document } from '../retrieval.js';

// A Connector maps a source's raw records to the generic `Document` shape — the ONE place per source that understands its schema; everything downstream is source-agnostic. Generic over `R` so `toDocument` stays cast-free (a shared base type would widen to `unknown`).

export interface Connector<R> {
  /** Stable id for this source; becomes each produced Document's `source`. */
  readonly source: string;
  pull(): Promise<R[]>;
  toDocument(record: R): Document;
}

export async function collectDocuments<R>(connector: Connector<R>): Promise<Document[]> {
  const records = await connector.pull();
  return records.map((r) => connector.toDocument(r));
}
