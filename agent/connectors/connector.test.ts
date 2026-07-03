import { describe, it, expect } from 'vitest';
import { collectDocuments, type Connector } from './connector.js';
import { type Document } from '../retrieval.js';

// A minimal in-memory connector over an arbitrary record type — proves the
// interface is source-agnostic (anything mappable to a Document plugs in) and
// exercises collectDocuments without touching the filesystem.
function memoConnector(records: { key: string; note: string }[]): Connector<{ key: string; note: string }> {
  return {
    source: 'memo',
    pull: () => Promise.resolve(records),
    toDocument: (r): Document => ({ id: r.key, source: 'memo', title: r.key, text: r.note }),
  };
}

describe('collectDocuments', () => {
  it('pulls + maps every record to a Document, tagged with the source', async () => {
    const docs = await collectDocuments(memoConnector([
      { key: 'm1', note: 'first' },
      { key: 'm2', note: 'second' },
    ]));
    expect(docs).toEqual([
      { id: 'm1', source: 'memo', title: 'm1', text: 'first' },
      { id: 'm2', source: 'memo', title: 'm2', text: 'second' },
    ]);
  });

  it('returns [] for a source with no records', async () => {
    expect(await collectDocuments(memoConnector([]))).toEqual([]);
  });
});
