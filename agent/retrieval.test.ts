import { describe, it, expect } from 'vitest';
import { cosineSimilarity, TicketIndex, type Embedder } from './retrieval.js';
import { type Ticket } from '../shared/constants.js';

// Deterministic stub: maps any text containing a known keyword to a fixed
// vector, so cosine ordering is predictable without a live embedding model.
class StubEmbedder implements Embedder {
  constructor(private readonly map: [string, number[]][]) {}
  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.vec(t)));
  }
  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.vec(text));
  }
  private vec(text: string): number[] {
    const hit = this.map.find(([k]) => text.toLowerCase().includes(k));
    return hit ? hit[1] : [0, 0, 0, 1];
  }
}

function mk(id: string, title: string, body = ''): Ticket {
  return {
    id, title, body, type: 'task', priority: 'medium', status: 'backlog',
    order: 0, created: '', updated: '', project: null, blockers: [],
    parent: null, dueDate: null, assignee: null,
  };
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it('is 0 when a vector is all zeros (no NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/mismatch/);
  });
});

describe('TicketIndex', () => {
  const embedder = new StubEmbedder([
    ['login', [1, 0, 0]],
    ['dashboard', [0, 1, 0]],
    ['docs', [0, 0, 1]],
  ]);
  const board = (): Ticket[] => [
    mk('t1', 'Fix login bug'),
    mk('t2', 'Add dashboard charts'),
    mk('t3', 'Update docs'),
  ];

  it('returns the most semantically similar ticket first', async () => {
    const index = await TicketIndex.build(embedder, board());
    const results = await index.search('login screen is broken', 2);
    expect(results[0].id).toBe('t1');
    expect(results[0].score).toBeCloseTo(1);
    expect(results).toHaveLength(2);
  });

  it('respects the top-k limit', async () => {
    const index = await TicketIndex.build(embedder, board());
    expect(await index.search('login', 1)).toHaveLength(1);
  });

  it('returns [] for an empty board', async () => {
    const index = await TicketIndex.build(embedder, []);
    expect(index.size).toBe(0);
    expect(await index.search('anything')).toEqual([]);
  });
});
