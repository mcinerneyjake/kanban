import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cosineSimilarity, TicketIndex, RuntimeEmbedder, type Embedder } from './retrieval.js';
import { type Ticket } from '../shared/constants.js';
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
});
