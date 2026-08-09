import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTicketIndex, resetIndexCache, buildBoardIndex, buildCliIndex, defaultCachePath, resolveCachePath, embedUsage } from './indexCache.js';
import { type Embedder } from './retrieval.js';
import { createTicket } from '../../server/tickets.js';
import { type Ticket } from '../../shared/constants.js';

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

// Every test gets a COLD embedding cache. The persistent store is default-on since
// tkt-9f09b3a1e95c, so without this a warm cache from a prior test would silently satisfy
// the embeds a later test is counting — turning "did it re-embed?" assertions into
// order-dependent noise.
let cacheDirs: string[] = [];
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-indexcache-test-'));
  cacheDirs.push(dir);
  process.env.EMBED_CACHE_PATH = path.join(dir, 'embeddings.json');
  resetIndexCache();
});
afterAll(async () => {
  await Promise.all(cacheDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  cacheDirs = [];
});

describe('getTicketIndex', () => {
  it('builds once and reuses the cache for an unchanged board', async () => {
    const embedder = new CountingEmbedder();
    const tickets = [mk('t1', 'A'), mk('t2', 'B')];
    const first = await getTicketIndex({ embedder, tickets });
    const second = await getTicketIndex({ embedder, tickets });
    expect(embedder.builds).toBe(1);
    expect(second).toBe(first); // same cached instance
  });

  // Asserts index IDENTITY, not embed counts: since tkt-9f09b3a1e95c the embedding cache is
  // content-addressed, so a rebuild re-embeds only text that actually changed. Counting embeds
  // would conflate "the index was invalidated" (what this test is about) with "everything was
  // re-embedded" (the ~79s bug the cache exists to prevent).
  it('rebuilds when a ticket is updated or added', async () => {
    const embedder = new CountingEmbedder();
    const first = await getTicketIndex({ embedder, tickets: [mk('t1', 'A')] });

    const afterUpdate = await getTicketIndex({ embedder, tickets: [mk('t1', 'A', '2026-02-02')] });
    expect(afterUpdate).not.toBe(first); // invalidated by the `updated` stamp
    // …but the document text is unchanged, so the cache serves it — nothing re-embedded.
    expect(embedder.embeddedTexts).toHaveLength(1);

    const afterAdd = await getTicketIndex({ embedder, tickets: [mk('t1', 'A', '2026-02-02'), mk('t2', 'B')] });
    expect(afterAdd).not.toBe(afterUpdate);
    expect(afterAdd.size).toBe(2);
    expect(embedder.embeddedTexts).toHaveLength(2); // only the genuinely new document
    expect(embedder.embeddedTexts[1]).toContain('B');
  });

  it('is insensitive to ticket ordering', async () => {
    const embedder = new CountingEmbedder();
    await getTicketIndex({ embedder, tickets: [mk('t1', 'A'), mk('t2', 'B')] });
    await getTicketIndex({ embedder, tickets: [mk('t2', 'B'), mk('t1', 'A')] }); // same set, reordered
    expect(embedder.builds).toBe(1);
  });

  it('rebuilds when a ticket is removed', async () => {
    const embedder = new CountingEmbedder();
    const first = await getTicketIndex({ embedder, tickets: [mk('t1', 'A'), mk('t2', 'B')] });
    const after = await getTicketIndex({ embedder, tickets: [mk('t1', 'A')] }); // t2 removed
    expect(after).not.toBe(first);
    expect(after.size).toBe(1);
  });

  it('resetIndexCache forces a rebuild of the same board', async () => {
    const embedder = new CountingEmbedder();
    const tickets = [mk('t1', 'A')];
    const first = await getTicketIndex({ embedder, tickets });
    resetIndexCache();
    const after = await getTicketIndex({ embedder, tickets });
    expect(after).not.toBe(first); // a fresh instance, even though the board is identical
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
// tkt-9f09b3a1e95c: the SERVER path (getTicketIndex with no explicit cachePath) used to
// run pure in-memory, so every board change re-embedded all ~816 tickets — ~79s per in-app
// draft. It now resolves the same persistent store the CLI uses. EMBED_CACHE_PATH is pinned
// to a temp file by the vitest setup, so these drive the real default-resolution path.
describe('getTicketIndex — server path is persistently cached (no explicit cachePath)', () => {
  it('re-embeds NOTHING on a rebuild after a simulated restart', async () => {
    const tickets = [mk('t1', 'Alpha'), mk('t2', 'Beta')];
    await getTicketIndex({ embedder: new CountingEmbedder(), tickets });

    resetIndexCache(); // drops the in-memory memo AND the loaded store — a process restart
    const warm = new CountingEmbedder();
    await getTicketIndex({ embedder: warm, tickets });

    expect(warm.embeddedTexts).toEqual([]);
  });

  it('re-embeds ONLY the changed ticket when the board changes', async () => {
    await getTicketIndex({ embedder: new CountingEmbedder(), tickets: [mk('t1', 'Alpha')] });

    const next = new CountingEmbedder();
    await getTicketIndex({ embedder: next, tickets: [mk('t1', 'Alpha'), mk('t2', 'Beta')] });

    expect(next.embeddedTexts).toHaveLength(1);
    expect(next.embeddedTexts[0]).toContain('Beta');
  });
});

describe('embedUsage', () => {
  // The intake controller reads this before the first index build of a process. It must
  // report an empty run rather than throw — the alternative is a 500 on the first draft.
  it('reports empty usage when no runtime embedder has been created yet', () => {
    resetIndexCache();
    const usage = embedUsage();
    expect(usage.calls).toBe(0);
    expect(usage.activeMs).toBe(0);
  });

  // An injected stub is NOT the shared runtime embedder, so its work is deliberately not
  // metered here — the meter tracks real runtime calls, and tests inject fakes freely.
  it('stays empty when a stub embedder is injected', async () => {
    await getTicketIndex({ embedder: new CountingEmbedder(), tickets: [mk('t1', 'A')] });
    expect(embedUsage().calls).toBe(0);
  });
});

describe('resolveCachePath', () => {
  const prev = process.env.EMBED_CACHE_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.EMBED_CACHE_PATH;
    else process.env.EMBED_CACHE_PATH = prev;
  });

  it('prefers an explicit path over the env var', () => {
    process.env.EMBED_CACHE_PATH = '/env/path.json';
    expect(resolveCachePath('/explicit/path.json')).toBe('/explicit/path.json');
  });

  it('falls back to EMBED_CACHE_PATH when no explicit path is given', () => {
    process.env.EMBED_CACHE_PATH = '/env/path.json';
    expect(resolveCachePath()).toBe('/env/path.json');
  });

  // The behaviour change: unset used to mean "no cache at all" (null), which is what
  // left the server re-embedding the whole board on every draft.
  it('falls back to the default board cache when nothing is configured', () => {
    delete process.env.EMBED_CACHE_PATH;
    expect(resolveCachePath()).toBe(defaultCachePath());
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

// The CLI cache wiring (tkt-a74040f7cbed): the one-shot CLIs now persist embeddings so a warm run
// re-embeds only what changed, instead of the ~65s cold re-embed every run.
describe('buildCliIndex + defaultCachePath', () => {
  let tmpDir: string;
  let cacheFile: string;
  // Restore rather than delete: the vitest setup pins EMBED_CACHE_PATH away from the real
  // board cache, and deleting it would unpin every later suite in this worker.
  const pinnedCachePath = process.env.EMBED_CACHE_PATH;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-clicache-test-'));
    process.env.TICKETS_DIR_OVERRIDE = tmpDir;
    cacheFile = path.join(tmpDir, '.cache', 'embeddings.json');
    process.env.EMBED_CACHE_PATH = cacheFile; // pin the path so the test controls it
    resetIndexCache();
  });
  afterEach(async () => {
    delete process.env.TICKETS_DIR_OVERRIDE;
    if (pinnedCachePath === undefined) delete process.env.EMBED_CACHE_PATH;
    else process.env.EMBED_CACHE_PATH = pinnedCachePath;
    resetIndexCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('defaultCachePath resolves to <boardRoot>/.cache/embeddings.json, override-aware and absolute', () => {
    process.env.BOARD_DIR_OVERRIDE = '/tmp/some-board';
    try {
      const p = defaultCachePath();
      expect(path.isAbsolute(p)).toBe(true);
      expect(p.endsWith(path.join('.cache', 'embeddings.json'))).toBe(true);
      // <boardRoot>/tickets/.. collapses to <boardRoot>; the tickets dir must not leak into the path.
      expect(p).not.toContain(`${path.sep}tickets${path.sep}`);
    } finally {
      delete process.env.BOARD_DIR_OVERRIDE;
    }
  });

  it('embeds the board cold, then re-embeds NOTHING on a warm "restart"', async () => {
    await createTicket({ title: 'Cacheable ticket one' });
    await createTicket({ title: 'Cacheable ticket two' });

    const cold = new CountingEmbedder();
    const first = await buildCliIndex(cold);
    expect(cold.builds).toBe(1);          // cold cache → one embed pass
    expect(first.size).toBe(2);

    resetIndexCache();                     // drop in-memory index + loaded store → a fresh process
    const warm = new CountingEmbedder();
    const second = await buildCliIndex(warm);
    expect(warm.builds).toBe(0);           // served entirely from the persisted cache on disk
    expect(second.size).toBe(2);
  });
});
