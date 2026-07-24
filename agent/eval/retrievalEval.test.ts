import { describe, it, expect } from 'vitest';
import { DocumentIndex, type Embedder, type Document } from '../retrieval/retrieval.js';
import { evaluateRetrieval, assertRetrievalInstruments } from './retrievalEval.js';
import { POSITIVE_CONTROL, NEGATIVE_CONTROL, type GoldenPair } from './golden.js';

// Deterministic embedder: each document is a one-hot basis vector by build order, so cosine is 1 for
// the matching query and 0 otherwise — recall is exactly controllable without a runtime. A query maps
// to a target doc index, or 'uniform' (equal weight on all docs) to model a no-answer query whose best
// cosine is 1/sqrt(dim) — deliberately weak, for the negative control.
class ControlledEmbedder implements Embedder {
  constructor(private readonly dim: number, private readonly queryTargets: Map<string, number | 'uniform'>) {}
  private oneHot(i: number): number[] {
    return Array.from({ length: this.dim }, (_, j) => (j === i ? 1 : 0));
  }
  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((_, i) => this.oneHot(i)));
  }
  embedQuery(text: string): Promise<number[]> {
    const t = this.queryTargets.get(text);
    if (t === 'uniform') return Promise.resolve(Array.from({ length: this.dim }, () => 1));
    if (typeof t === 'number') return Promise.resolve(this.oneHot(t));
    return Promise.resolve(Array.from({ length: this.dim }, () => 0.01)); // unknown query — weak, no strong match
  }
}

function doc(id: string, i: number): Document {
  return { id, source: 'kanban', title: `title ${i}`, text: `body text for ${id} number ${i}` };
}

// A 6-doc board whose 4th entry is the real positive-control ticket, so the imported control constants
// resolve against it. Extra queryTargets override the control routing per test.
const CONTROL_ID = POSITIVE_CONTROL.expectedId;
const IDS = ['tkt-a', 'tkt-b', 'tkt-c', CONTROL_ID, 'tkt-e', 'tkt-f'];
const CONTROL_IDX = IDS.indexOf(CONTROL_ID);

function buildIndex(extraTargets: [string, number | 'uniform'][] = []): Promise<DocumentIndex> {
  const targets = new Map<string, number | 'uniform'>([
    [POSITIVE_CONTROL.query, CONTROL_IDX],       // positive control lands on its ticket → top-1
    [NEGATIVE_CONTROL.query, 'uniform'],         // negative control is weak everywhere
    ...extraTargets,
  ]);
  const embedder = new ControlledEmbedder(IDS.length, targets);
  return DocumentIndex.build(embedder, IDS.map((id, i) => doc(id, i)));
}

describe('assertRetrievalInstruments (loud gate — proven to go red)', () => {
  it('passes when the corpus is non-empty and both controls hold', async () => {
    await expect(assertRetrievalInstruments(await buildIndex())).resolves.toBeUndefined();
  });

  it('throws LOUD on an empty index rather than reporting recall over nothing', async () => {
    const empty = await DocumentIndex.build(new ControlledEmbedder(1, new Map()), []);
    await expect(assertRetrievalInstruments(empty)).rejects.toThrow(/EMPTY/);
  });

  it('throws when the POSITIVE control does not rank top-1 (embedder miswired)', async () => {
    // Route the positive-control query to the WRONG doc → rank !== 1.
    const idx = await buildIndex([[POSITIVE_CONTROL.query, 0]]);
    await expect(assertRetrievalInstruments(idx)).rejects.toThrow(/POSITIVE control failed/);
  });

  it('throws when the NEGATIVE control scores a confident hit (index asserts a non-existent answer)', async () => {
    // Route the no-answer query to a real doc → cosine 1.0 ≥ threshold.
    const idx = await buildIndex([[NEGATIVE_CONTROL.query, 0]]);
    await expect(assertRetrievalInstruments(idx)).rejects.toThrow(/NEGATIVE control failed/);
  });
});

describe('evaluateRetrieval', () => {
  it('computes recall/MRR over a golden set and passes the instrument gate', async () => {
    const pairs: GoldenPair[] = [
      { query: 'find a', expectedId: 'tkt-a' },
      { query: 'find c', expectedId: 'tkt-c' },
    ];
    const idx = await buildIndex([['find a', 0], ['find c', 2]]);
    const report = await evaluateRetrieval(idx, pairs);
    expect(report.metrics).toMatchObject({ recallAt1: 1, recallAt5: 1, mrr: 1 });
    expect(report.results.map((r) => r.rank)).toEqual([1, 1]);
  });

  it('scores a genuine miss as recall 0 rather than hiding it', async () => {
    // The query confidently retrieves the WRONG doc (tkt-e), so the expected tkt-a is not top-1.
    const pairs: GoldenPair[] = [{ query: 'points elsewhere', expectedId: 'tkt-a' }];
    const idx = await buildIndex([['points elsewhere', 4]]);
    const report = await evaluateRetrieval(idx, pairs);
    expect(report.results[0].rank).not.toBe(1);
    expect(report.metrics.recallAt1).toBe(0);
  });

  it('aborts the whole eval (no metrics) when the instrument gate throws', async () => {
    const empty = await DocumentIndex.build(new ControlledEmbedder(1, new Map()), []);
    await expect(evaluateRetrieval(empty, [{ query: 'x', expectedId: 'tkt-a' }])).rejects.toThrow(/EMPTY/);
  });
});
