import { describe, it, expect, beforeEach } from 'vitest';
import { getTicketIndex, resetIndexCache } from './indexCache.js';
import { type Embedder } from './retrieval.js';
import { type Ticket } from '../shared/constants.js';

// Counts how many times the whole board is (re)embedded — one call per build.
class CountingEmbedder implements Embedder {
  public builds = 0;
  embedDocuments(texts: string[]): Promise<number[][]> {
    this.builds++;
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  }
  embedQuery(): Promise<number[]> { return Promise.resolve([1, 0, 0]); }
}

function mk(id: string, title: string, updated = '2026-01-01'): Ticket {
  return {
    id, title, body: '', type: 'task', priority: 'medium', status: 'backlog',
    order: 0, created: '', updated, project: null, blockers: [], parent: null, dueDate: null, assignee: null,
  };
}

beforeEach(() => resetIndexCache());

describe('getTicketIndex', () => {
  it('builds once and reuses the cache for an unchanged board', async () => {
    const embedder = new CountingEmbedder();
    const tickets = [mk('t1', 'A'), mk('t2', 'B')];
    const first = await getTicketIndex({ embedder, tickets });
    const second = await getTicketIndex({ embedder, tickets });
    expect(embedder.builds).toBe(1);
    expect(second).toBe(first); // same cached instance
  });

  it('rebuilds when a ticket is updated or added', async () => {
    const embedder = new CountingEmbedder();
    await getTicketIndex({ embedder, tickets: [mk('t1', 'A')] });
    await getTicketIndex({ embedder, tickets: [mk('t1', 'A', '2026-02-02')] }); // t1 updated
    await getTicketIndex({ embedder, tickets: [mk('t1', 'A', '2026-02-02'), mk('t2', 'B')] }); // added
    expect(embedder.builds).toBe(3);
  });

  it('is insensitive to ticket ordering', async () => {
    const embedder = new CountingEmbedder();
    await getTicketIndex({ embedder, tickets: [mk('t1', 'A'), mk('t2', 'B')] });
    await getTicketIndex({ embedder, tickets: [mk('t2', 'B'), mk('t1', 'A')] }); // same set, reordered
    expect(embedder.builds).toBe(1);
  });

  it('rebuilds when a ticket is removed', async () => {
    const embedder = new CountingEmbedder();
    await getTicketIndex({ embedder, tickets: [mk('t1', 'A'), mk('t2', 'B')] });
    await getTicketIndex({ embedder, tickets: [mk('t1', 'A')] }); // t2 removed
    expect(embedder.builds).toBe(2);
  });

  it('resetIndexCache forces a rebuild of the same board', async () => {
    const embedder = new CountingEmbedder();
    const tickets = [mk('t1', 'A')];
    await getTicketIndex({ embedder, tickets });
    resetIndexCache();
    await getTicketIndex({ embedder, tickets });
    expect(embedder.builds).toBe(2);
  });
});
