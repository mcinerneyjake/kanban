import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTicketIndex, resetIndexCache, buildBoardIndex } from './indexCache.js';
import { type Embedder } from './retrieval.js';
import { createTicket } from '../server/tickets.js';
import { type Ticket } from '../shared/constants.js';

// Counts embedDocuments calls (one per non-cached build) and records the texts
// it was actually asked to embed — the proxy for "what got re-embedded".
class CountingEmbedder implements Embedder {
  public builds = 0;
  public embeddedTexts: string[] = [];
  embedDocuments(texts: string[]): Promise<number[][]> {
    this.builds++;
    this.embeddedTexts.push(...texts);
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

// Persistent embedding cache (opt-in via EMBED_CACHE_PATH). The unchanged tests
// above never set it, so they run purely in memory with the raw embed counts.
describe('getTicketIndex — persistent embedding cache', () => {
  let cacheDir: string;
  let cachePath: string;
  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-embed-cache-test-'));
    cachePath = path.join(cacheDir, 'embeddings.json');
  });
  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('persists embeddings so a rebuild after "restart" re-embeds nothing', async () => {
    const tickets = [mk('t1', 'A'), mk('t2', 'B')];
    const cold = new CountingEmbedder();
    await getTicketIndex({ embedder: cold, tickets, cachePath });
    expect(cold.builds).toBe(1); // cold cache → embedded once

    resetIndexCache(); // drops the in-memory index AND the loaded store → a restart
    const warm = new CountingEmbedder();
    const index = await getTicketIndex({ embedder: warm, tickets, cachePath });
    expect(warm.builds).toBe(0); // served from the persisted cache on disk
    expect(index.size).toBe(2);
  });

  it('re-embeds only new content when the board changes', async () => {
    await getTicketIndex({ embedder: new CountingEmbedder(), tickets: [mk('t1', 'A')], cachePath });
    resetIndexCache();
    const next = new CountingEmbedder();
    // 'A' is cached from the first build; only 'B' is new.
    await getTicketIndex({ embedder: next, tickets: [mk('t1', 'A'), mk('t2', 'B')], cachePath });
    expect(next.builds).toBe(1);
    expect(next.embeddedTexts).toEqual(['B']);
  });

  it('does not wipe the cache when the board is transiently empty', async () => {
    await getTicketIndex({ embedder: new CountingEmbedder(), tickets: [mk('t1', 'A')], cachePath });
    resetIndexCache();
    // A build over an empty board must NOT prune the cache to nothing.
    await getTicketIndex({ embedder: new CountingEmbedder(), tickets: [], cachePath });
    resetIndexCache();
    const warm = new CountingEmbedder();
    await getTicketIndex({ embedder: warm, tickets: [mk('t1', 'A')], cachePath });
    expect(warm.builds).toBe(0); // 'A' survived the empty build
  });
});

// ticket→Document mapping now lives in the TicketConnector — see
// connectors.test.ts. These tests cover the cache's use of it end-to-end.
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
