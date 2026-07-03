import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cosineSimilarity, DocumentIndex, RuntimeEmbedder, type Document, type Embedder } from './retrieval.js';
import { type EmbedConfig } from './models.js';

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

// Minimal Document factory. `text` defaults to the title (most tests only need
// the title to drive the stub); pass it explicitly to test body/meta handling.
function doc(id: string, title: string, text = title, meta?: Record<string, string>): Document {
  return { id, source: 'test', title, text, ...(meta ? { meta } : {}) };
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

describe('DocumentIndex', () => {
  const embedder = new StubEmbedder([
    ['login', [1, 0, 0]],
    ['dashboard', [0, 1, 0]],
    ['docs', [0, 0, 1]],
  ]);
  const corpus = (): Document[] => [
    doc('t1', 'Fix login bug'),
    doc('t2', 'Add dashboard charts'),
    doc('t3', 'Update docs'),
  ];

  it('returns the most semantically similar document first', async () => {
    const index = await DocumentIndex.build(embedder, corpus());
    const results = await index.search('login screen is broken', 2);
    expect(results[0].id).toBe('t1');
    expect(results[0].score).toBeCloseTo(1);
    expect(results).toHaveLength(2);
  });

  it('respects the top-k limit', async () => {
    const index = await DocumentIndex.build(embedder, corpus());
    expect(await index.search('login', 1)).toHaveLength(1);
  });

  it('carries each document\'s source + meta through to its result', async () => {
    const index = await DocumentIndex.build(embedder, [
      doc('t1', 'Fix login bug', 'Fix login bug', { status: 'done' }),
      doc('t2', 'Add dashboard charts', 'Add dashboard charts', { status: 'in-progress' }),
    ]);
    const results = await index.search('login', 2);
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('t1')?.meta?.status).toBe('done');
    expect(byId.get('t2')?.meta?.status).toBe('in-progress');
    expect(byId.get('t1')?.source).toBe('test');
  });

  it('returns [] for an empty corpus', async () => {
    const index = await DocumentIndex.build(embedder, []);
    expect(index.size).toBe(0);
    expect(await index.search('anything')).toEqual([]);
  });

  it('embeds the full text, not just the title', async () => {
    // Identical titles with no keyword — only `text` can drive the match, so
    // this fails if the index ever stops embedding the whole text.
    const index = await DocumentIndex.build(embedder, [
      doc('a', 'Item', 'resolve the login flow'),
      doc('b', 'Item', 'tweak the dashboard widget'),
    ]);
    const results = await index.search('login', 1);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeCloseTo(1);
  });

  it('returns [] when k is 0', async () => {
    const index = await DocumentIndex.build(embedder, corpus());
    expect(await index.search('login', 0)).toEqual([]);
  });

  it('throws if the embedder returns the wrong number of vectors', async () => {
    const broken: Embedder = {
      embedDocuments: (texts) => Promise.resolve(texts.slice(1).map(() => [1])),
      embedQuery: () => Promise.resolve([1]),
    };
    await expect(DocumentIndex.build(broken, [doc('a', 'x'), doc('b', 'y')]))
      .rejects.toThrow(/returned 1 vectors for 2/);
  });
});

// --- RuntimeEmbedder (mocked fetch) ----------------------------------------

interface EmbedRequest { model: string; input: string[] }
function isEmbedRequest(v: unknown): v is EmbedRequest {
  return typeof v === 'object' && v !== null
    && 'model' in v && typeof v.model === 'string'
    && 'input' in v && Array.isArray(v.input) && v.input.every((s) => typeof s === 'string');
}

const nomicCfg: EmbedConfig = {
  baseUrl: 'http://test/v1', model: 'nomic-embed-text',
  queryInstruction: 'search_query: ', docInstruction: 'search_document: ',
};

// Deterministic per-string "embedding" so output order is verifiable across batches.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i);
  return h;
}

describe('RuntimeEmbedder (mocked fetch)', () => {
  let requests: EmbedRequest[] = [];

  function stubFetch(respond: (req: EmbedRequest) => { status?: number; json?: unknown; text?: string }) {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const parsed: unknown = JSON.parse(raw);
      if (!isEmbedRequest(parsed)) throw new Error('test: bad request body');
      requests.push(parsed);
      const r = respond(parsed);
      const payload = r.text ?? JSON.stringify(r.json ?? {});
      return new Response(payload, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }));
  }

  // Echo each input as a 1-d embedding = [hash(input)], in order.
  const echo = (req: EmbedRequest) => ({ json: { data: req.input.map((s, i) => ({ index: i, embedding: [hash(s)] })) } });

  beforeEach(() => { requests = []; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('prefixes documents with docInstruction', async () => {
    stubFetch(echo);
    await new RuntimeEmbedder(nomicCfg).embedDocuments(['alpha', 'beta']);
    expect(requests[0].input).toEqual(['search_document: alpha', 'search_document: beta']);
  });

  it('prefixes the query with queryInstruction', async () => {
    stubFetch(echo);
    await new RuntimeEmbedder(nomicCfg).embedQuery('find me');
    expect(requests[0].input).toEqual(['search_query: find me']);
  });

  it('realigns out-of-order response data to input order', async () => {
    stubFetch((req) => ({ json: { data: req.input.map((s, i) => ({ index: i, embedding: [hash(s)] })).reverse() } }));
    const vecs = await new RuntimeEmbedder(nomicCfg).embedDocuments(['a', 'bb', 'ccc']);
    expect(vecs).toEqual([
      [hash('search_document: a')], [hash('search_document: bb')], [hash('search_document: ccc')],
    ]);
  });

  it('batches large inputs across multiple requests, preserving order', async () => {
    stubFetch(echo);
    const inputs = Array.from({ length: 70 }, (_, i) => `item-${i}`);
    const vecs = await new RuntimeEmbedder(nomicCfg).embedDocuments(inputs);
    expect(requests.length).toBe(2); // 70 / 64 → two batches
    expect(vecs).toHaveLength(70);
    expect(vecs[0]).toEqual([hash('search_document: item-0')]);
    expect(vecs[69]).toEqual([hash('search_document: item-69')]);
  });

  it('makes no request for an empty document set', async () => {
    stubFetch(echo);
    const vecs = await new RuntimeEmbedder(nomicCfg).embedDocuments([]);
    expect(vecs).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('surfaces the response body on a non-OK status', async () => {
    stubFetch(() => ({ status: 400, text: 'unknown model' }));
    await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/400.*unknown model/);
  });

  it('throws when the query returns no vector', async () => {
    stubFetch(() => ({ json: { data: [] } }));
    await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/no vector/);
  });

  it('reports a friendly error when the request times out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/timed out/);
  });

  it('getUsage() accumulates embedding usage + active time across batches (injected clock)', async () => {
    const times = [0, 10, 100, 130]; let i = 0;
    stubFetch((req) => ({ json: {
      data: req.input.map((s, idx) => ({ index: idx, embedding: [hash(s)] })),
      usage: { prompt_tokens: req.input.length, total_tokens: req.input.length },
    } }));
    const embedder = new RuntimeEmbedder(nomicCfg, () => times[i++]);
    await embedder.embedDocuments(Array.from({ length: 70 }, (_, n) => `x-${n}`)); // 64 + 6 → 2 batches
    expect(embedder.getUsage()).toMatchObject({
      calls: 2, reportedCalls: 2, promptTokens: 70, totalTokens: 70, completionTokens: 0, activeMs: 40,
    });
  });

  it('getUsage() records time but marks tokens unavailable when usage is omitted', async () => {
    const times = [0, 8]; let i = 0;
    stubFetch(echo); // echo returns no usage field
    const embedder = new RuntimeEmbedder(nomicCfg, () => times[i++]);
    await embedder.embedQuery('hello');
    expect(embedder.getUsage()).toMatchObject({ calls: 1, reportedCalls: 0, totalTokens: 0, activeMs: 8 });
  });

  it('getUsage() falls back to prompt_tokens for total when total is missing', async () => {
    const times = [0, 5]; let i = 0;
    stubFetch((req) => ({ json: {
      data: req.input.map((s, idx) => ({ index: idx, embedding: [hash(s)] })),
      usage: { prompt_tokens: 3 },
    } }));
    const embedder = new RuntimeEmbedder(nomicCfg, () => times[i++]);
    await embedder.embedDocuments(['a', 'b', 'c']);
    expect(embedder.getUsage()).toMatchObject({
      promptTokens: 3, totalTokens: 3, completionTokens: 0, calls: 1, reportedCalls: 1, activeMs: 5,
    });
  });

  it('does not count a failed (non-OK) batch in usage', async () => {
    stubFetch(() => ({ status: 400, text: 'nope' }));
    const embedder = new RuntimeEmbedder(nomicCfg);
    await expect(embedder.embedQuery('x')).rejects.toThrow();
    expect(embedder.getUsage()).toMatchObject({ calls: 0, reportedCalls: 0, activeMs: 0 });
  });

  it('records nothing for an empty document set', async () => {
    stubFetch(echo);
    const embedder = new RuntimeEmbedder(nomicCfg);
    await embedder.embedDocuments([]);
    expect(embedder.getUsage()).toMatchObject({ calls: 0, reportedCalls: 0, totalTokens: 0, activeMs: 0 });
  });
});
