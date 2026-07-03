import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTicketIndex, resetIndexCache, ticketToDocument, buildBoardIndex } from './indexCache.js';
import { type Embedder } from './retrieval.js';
import { createTicket } from '../server/tickets.js';
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

  it('coalesces concurrent builds, then releases so the next change rebuilds', async () => {
    const embedder = new CountingEmbedder();
    const tickets = [mk('t1', 'A'), mk('t2', 'B')];
    const [a, b] = await Promise.all([
      getTicketIndex({ embedder, tickets }),
      getTicketIndex({ embedder, tickets }),
    ]);
    expect(embedder.builds).toBe(1); // one shared embedding pass, not two
    expect(a).toBe(b);
    // the in-flight build was released, so a later change rebuilds
    await getTicketIndex({ embedder, tickets: [...tickets, mk('t3', 'C')] });
    expect(embedder.builds).toBe(2);
  });

  it('releases the in-flight build on failure so the next call retries (warm fallback)', async () => {
    let attempts = 0;
    const flaky: Embedder = {
      embedDocuments: (texts) => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error('embedder down'))
          : Promise.resolve(texts.map(() => [1, 0, 0]));
      },
      embedQuery: () => Promise.resolve([1, 0, 0]),
    };
    const tickets = [mk('t1', 'A')];
    await expect(getTicketIndex({ embedder: flaky, tickets })).rejects.toThrow(/embedder down/);
    // pending was released, so this retries (not the rejected promise)
    const index = await getTicketIndex({ embedder: flaky, tickets });
    expect(index.size).toBe(1);
    expect(attempts).toBe(2);
  });
});

// The ticket → Document bridge: the one place that knows what a ticket is. The
// retrieval layer downstream is source-agnostic (see retrieval.test.ts).
describe('ticketToDocument', () => {
  it('maps a ticket to a source-tagged Document, carrying status in meta', () => {
    const d = ticketToDocument(mk('t1', 'Fix login'));
    expect(d).toMatchObject({ id: 't1', source: 'ticket', title: 'Fix login', meta: { status: 'backlog' } });
  });

  it('embeds the body into text, not just the title', () => {
    const d = ticketToDocument({ ...mk('t1', 'Title'), body: 'the login flow is broken' });
    expect(d.text).toContain('Title');
    expect(d.text).toContain('the login flow is broken');
  });
});

describe('buildBoardIndex', () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-indexcache-test-'));
    process.env.TICKETS_DIR_OVERRIDE = tmpDir;
  });
  afterAll(async () => {
    delete process.env.TICKETS_DIR_OVERRIDE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads the live board when no tickets argument is given', async () => {
    await createTicket({ title: 'Live ticket' });
    const index = await buildBoardIndex(new CountingEmbedder());
    expect(index.size).toBeGreaterThan(0);
  });

  it('carries each ticket\'s status through to search results', async () => {
    const index = await buildBoardIndex(new CountingEmbedder(), [
      { ...mk('t1', 'Fix login bug'), status: 'done' },
      { ...mk('t2', 'Add dashboard'), status: 'in-progress' },
    ]);
    const results = await index.search('anything', 2);
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('t1')?.meta?.status).toBe('done');
    expect(byId.get('t2')?.meta?.status).toBe('in-progress');
  });
});
