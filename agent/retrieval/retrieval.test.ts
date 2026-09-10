import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cosineSimilarity, DocumentIndex, RuntimeEmbedder, type Document, type Embedder } from './retrieval.js';
import { type EmbedConfig } from './models.js';
import { isRuntimeUnavailable } from '../runtime/unavailable.js';
import { buildSummary } from '../cost/summary.js';
import { resolveCostConfig } from '../cost/costConfig.js';

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

describe('DocumentIndex — chunking', () => {
  // Constant embedder: every text (chunk or query) maps to the same vector, so
  // all chunks score equally — these tests assert chunk/rollup STRUCTURE, not
  // ranking (ranking is covered above and in chunk.test.ts).
  const flat: Embedder = {
    embedDocuments: (texts) => Promise.resolve(texts.map(() => [1, 0, 0])),
    embedQuery: () => Promise.resolve([1, 0, 0]),
  };
  const long = 'x'.repeat(100); // size 40 / overlap 0 → 3 windows: [0,40) [40,80) [80,100)

  it('with no chunk config, indexes one entry per document (unchanged behavior)', async () => {
    const index = await DocumentIndex.build(flat, [doc('d1', 'Doc', long)]);
    expect(index.size).toBe(1);
  });

  it('splits an oversized document into multiple embedded chunks', async () => {
    const index = await DocumentIndex.build(flat, [doc('d1', 'Doc', long)], { size: 40, overlap: 0 });
    expect(index.size).toBe(3);
  });

  it('rolls up to one hit per parent document by default (real id, no chunk detail)', async () => {
    const index = await DocumentIndex.build(flat, [doc('d1', 'Doc', long)], { size: 40, overlap: 0 });
    const results = await index.search('anything', 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('d1');
    expect(results[0].chunk).toBeUndefined();
  });

  it('returns per-chunk hits with the matched chunk index + text when rollup is off', async () => {
    const index = await DocumentIndex.build(flat, [doc('d1', 'Doc', long)], { size: 40, overlap: 0 });
    const hits = await index.search('anything', 5, { rollup: false });
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.id === 'd1')).toBe(true);
    expect([...hits].map((h) => h.chunk?.index).sort()).toEqual([0, 1, 2]);
    expect(hits.every((h) => typeof h.chunk?.text === 'string' && h.chunk.text.length > 0)).toBe(true);
  });

  it('drops a document with empty/whitespace text — consistently, chunking on or off', async () => {
    const docs = [doc('empty', 'No body', '   '), doc('real', 'Has text', 'has real content')];
    const off = await DocumentIndex.build(flat, docs);
    const on = await DocumentIndex.build(flat, docs, { size: 40, overlap: 0 });
    expect(off.size).toBe(1); // only 'real' — no-chunk path drops the empty doc too
    expect(on.size).toBe(1);
    expect((await off.search('anything', 5)).map((r) => r.id)).toEqual(['real']);
  });

  it('does not inflate the document count when rolling up a multi-chunk corpus', async () => {
    const index = await DocumentIndex.build(
      flat,
      [doc('d1', 'One', long), doc('d2', 'Two', long)],
      { size: 40, overlap: 0 },
    );
    expect(index.size).toBe(6); // 2 docs × 3 chunks
    const ids = (await index.search('anything', 10)).map((r) => r.id).sort();
    expect(ids).toEqual(['d1', 'd2']); // rolled up to the two parents
  });

  // documentIds backs the eval's anchor-presence gate (tkt-0a076c4d3084). Chunking on is the case that
  // decides whether that gate false-alarms: 6 entries must collapse to the 2 parent ids, not report 6.
  it('reports distinct parent document ids with chunking on, not one per chunk', async () => {
    const index = await DocumentIndex.build(
      flat,
      [doc('d1', 'One', long), doc('d2', 'Two', long)],
      { size: 40, overlap: 0 },
    );
    expect(index.size).toBe(6);
    expect([...index.documentIds].sort()).toEqual(['d1', 'd2']);
  });

  it('reports an empty id set for an empty corpus, so absence is never mistaken for presence', async () => {
    const index = await DocumentIndex.build(flat, []);
    expect([...index.documentIds]).toEqual([]);
    expect(index.documentIds.has('d1')).toBe(false);
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

// How the stub runtime answers GET /models. Defaults to serving nomicCfg's model, so the preflight
// that guards every embed call is satisfied and each pre-existing test keeps its original meaning.
type ModelsReply = { status?: number; json?: unknown; text?: string } | 'network-error';
const servingNomic: ModelsReply = { json: { data: [{ id: nomicCfg.model }] } };

describe('RuntimeEmbedder (mocked fetch)', () => {
  let requests: EmbedRequest[] = [];
  let urls: string[] = [];
  let modelsReply: ModelsReply = servingNomic;

  function stubFetch(respond: (req: EmbedRequest) => { status?: number; json?: unknown; text?: string }) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/models')) {
        if (modelsReply === 'network-error') throw new TypeError('fetch failed');
        const body = modelsReply.text ?? JSON.stringify(modelsReply.json ?? {});
        return new Response(body, { status: modelsReply.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
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

  beforeEach(() => { requests = []; urls = []; modelsReply = servingNomic; });
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

  // Times out only on /embeddings; the preflight's /models GET still succeeds. Without that split this
  // test was satisfied by the preflight's own timeout branch and stopped covering fetchEmbeddings
  // entirely — gutting the branch below left the suite 44/44 green (measured, tkt-01b784eb0030).
  it('reports a friendly error when the EMBEDDINGS request times out', async () => {
    const original = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: nomicCfg.model }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(original);
    }));
    // The friendly message replaces the opaque 'aborted'; `cause` keeps the original reachable
    // for diagnosis (preserve-caught-error, tkt-bcbca06a0df3).
    await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/Embeddings request timed out/);
    await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toMatchObject({ cause: original });
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

  // tkt-78eedf738778: LM Studio's /v1/embeddings returns {prompt_tokens: 0, total_tokens: 0} for a
  // real non-empty input — it doesn't count embedding tokens. A non-empty input is never genuinely 0
  // tokens, so a reported 0 means NOT COUNTED and must NOT increment reportedCalls (else it reads as a
  // measured zero, violating the cost epic's measured-vs-assumed rule). activeMs is still recorded —
  // the compute happened; only the token count is unreported.
  it('getUsage() treats a reported 0-token embedding usage as UNREPORTED, not a measured zero', async () => {
    const times = [0, 6]; let i = 0;
    stubFetch((req) => ({ json: {
      data: req.input.map((s, idx) => ({ index: idx, embedding: [hash(s)] })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    } }));
    const embedder = new RuntimeEmbedder(nomicCfg, () => times[i++]);
    await embedder.embedDocuments(['a real non-empty ticket body']);
    expect(embedder.getUsage()).toMatchObject({
      calls: 1, reportedCalls: 0, promptTokens: 0, totalTokens: 0, activeMs: 6,
    });
  });

  // Seam test (tkt-78eedf738778): embedder 0-token response → meter → cost summary. An embed-only run
  // (index build, agent:search) must render "usage unavailable", NOT "0 tokens (measured)" which would
  // read as "embeddings are free". Locks the full path, not just the meter half.
  it('an embed-only 0-token run renders "usage unavailable" in the cost summary, not a measured zero', async () => {
    stubFetch((req) => ({ json: {
      data: req.input.map((s, idx) => ({ index: idx, embedding: [hash(s)] })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    } }));
    const embedder = new RuntimeEmbedder(nomicCfg);
    await embedder.embedDocuments(['a non-empty ticket body']);
    const summary = buildSummary({
      usage: embedder.getUsage(),
      outcome: { created: 0, updated: 0, declined: 0, noProposal: true, errored: false },
      reviewMs: 0, cfg: resolveCostConfig(), model: 'local', prefixText: 'p', dynamicText: 'd',
    });
    const totalTokens = summary.measured.find((l) => l.label === 'total tokens');
    expect(totalTokens?.amount).toBeNull();
    expect(totalTokens?.note).toMatch(/unavailable/i);
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

  // tkt-01b784eb0030. LM Studio answers 200 for a model id it does not serve and silently substitutes
  // a different one, so the status code cannot tell a correct run from a wrong one. Measured against
  // localhost:1234 on 2026-09-09: `qwen3-embedding:0.6b` (the old default) and `no-such-model-xyz`
  // both returned 200 with 768-d nomic vectors instead of the intended 1024-d qwen3.
  describe('model-served preflight', () => {
    const absentCfg: EmbedConfig = { ...nomicCfg, model: 'no-such-model-xyz' };

    it('refuses to embed a model the runtime does not serve (written first, observed red)', async () => {
      stubFetch(echo);
      await expect(new RuntimeEmbedder(absentCfg).embedDocuments(['a'])).rejects.toThrow(/no-such-model-xyz/);
    });

    it('fails BEFORE any embedding is computed, so no wrong-model vectors are produced', async () => {
      stubFetch(echo);
      const embedder = new RuntimeEmbedder(absentCfg);
      await expect(embedder.embedQuery('x')).rejects.toThrow();
      expect(requests).toHaveLength(0);                       // never reached /embeddings
      expect(embedder.getUsage()).toMatchObject({ calls: 0 }); // nothing metered
    });

    it('names the models the runtime does serve, so the error is actionable', async () => {
      stubFetch(echo);
      modelsReply = { json: { data: [{ id: 'model-a' }, { id: 'model-b' }] } };
      await expect(new RuntimeEmbedder(absentCfg).embedQuery('x')).rejects.toThrow(/model-a.*model-b/);
    });

    // "Can't check" must never return the permissive answer: each way of failing to learn the served
    // set has to block the run, not wave it through.
    it('treats an unreachable model list as failure, not permission to proceed', async () => {
      stubFetch(echo);
      modelsReply = 'network-error';
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/could not (list|verify)/i);
      expect(requests).toHaveLength(0);
    });

    it('treats a non-OK model list as failure', async () => {
      stubFetch(echo);
      modelsReply = { status: 500, text: 'boom' };
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/could not (list|verify)/i);
      expect(requests).toHaveLength(0);
    });

    it('treats an unparseable model list as failure', async () => {
      stubFetch(echo);
      modelsReply = { json: { data: 'not-an-array' } }; // no `data` array at all — nothing to read ids from
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/could not (list|verify)/i);
      expect(requests).toHaveLength(0);
    });

    // Distinct from the unparseable case above: the list PARSED, it simply advertises nothing usable.
    // That is a served-set answer ("this runtime offers no model by that id"), not a failure to read one.
    it('treats a parseable list with no usable ids as "not served", not as unreadable', async () => {
      stubFetch(echo);
      modelsReply = { json: { data: [{ nope: 1 }] } };
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/Served models: \(none\)/);
      expect(requests).toHaveLength(0);
    });

    it('embeds normally when the runtime serves the configured model', async () => {
      stubFetch(echo);
      const vecs = await new RuntimeEmbedder(nomicCfg).embedDocuments(['a', 'bb']);
      expect(vecs).toHaveLength(2);
      expect(requests).toHaveLength(1);
    });

    // A failed check must NOT be memoized. indexCache holds one embedder for the life of the process and
    // no production path resets it, so caching the rejection would turn a blip during the first search
    // into a permanent outage — every later call replaying a failure the runtime had recovered from.
    it('re-probes after a failed check instead of failing forever', async () => {
      stubFetch(echo);
      modelsReply = 'network-error';
      const embedder = new RuntimeEmbedder(nomicCfg);
      await expect(embedder.embedQuery('x')).rejects.toThrow(); // fails closed for THIS call
      expect(requests).toHaveLength(0);
      modelsReply = servingNomic;                               // runtime comes back
      await expect(embedder.embedQuery('x')).resolves.toBeDefined();
      expect(urls.filter((u) => u.endsWith('/models'))).toHaveLength(2);
    });

    it('verifies once under concurrent calls, and lets none through early', async () => {
      stubFetch(echo);
      const embedder = new RuntimeEmbedder(absentCfg);
      const results = await Promise.allSettled([
        embedder.embedQuery('a'), embedder.embedQuery('b'), embedder.embedDocuments(['c']),
      ]);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(requests).toHaveLength(0);
      expect(urls.filter((u) => u.endsWith('/models'))).toHaveLength(1);
    });

    // Classification drives HTTP 503-vs-500 through intake.ts, so each shape is pinned by TYPE, not by
    // message text. unavailable.ts's rule is that recognition must be POSITIVE: only evidence the
    // runtime is down may claim it is.
    it('classifies a missing model as a config fault, not unavailability', async () => {
      stubFetch(echo);
      await expect(new RuntimeEmbedder(absentCfg).embedQuery('x')).rejects.toSatisfy(
        (e: unknown) => !isRuntimeUnavailable(e),
      );
    });

    it('classifies a gateway status as unavailability, but a 404 as a fault', async () => {
      stubFetch(echo);
      modelsReply = { status: 503, text: 'down' };
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toSatisfy(isRuntimeUnavailable);
      // A 404 is the shape EMBED_BASE_URL missing its /v1 suffix produces — a fault, so it stays on the
      // 500 path where asyncWrap logs the body, instead of becoming "is the model running?".
      modelsReply = { status: 404, text: 'not found' };
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toSatisfy(
        (e: unknown) => !isRuntimeUnavailable(e),
      );
    });

    it('reports the model-list timeout as its own request, not as an embeddings one', async () => {
      const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
        urls.push(String(input));
        return Promise.reject(timeout);
      }));
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/Model list request timed out/);
    });

    it('skips a malformed list entry rather than blocking on the whole list', async () => {
      stubFetch(echo);
      modelsReply = { json: { data: [{}, { id: nomicCfg.model }] } };
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).resolves.toBeDefined();
    });

    // The list check cannot see residency (GET /models lists downloaded models, loaded or not), so the
    // response's own `model` field is the only POSITIVE evidence of what actually ran.
    it('refuses vectors when the response says a different model ran', async () => {
      stubFetch((req) => ({ json: {
        model: 'text-embedding-nomic-embed-text-v1.5',
        data: req.input.map((str, i) => ({ index: i, embedding: [hash(str)] })),
      } }));
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).rejects.toThrow(/ran on "text-embedding-nomic/);
    });

    it('accepts vectors when the response echoes the requested model', async () => {
      stubFetch((req) => ({ json: {
        model: nomicCfg.model,
        data: req.input.map((str, i) => ({ index: i, embedding: [hash(str)] })),
      } }));
      await expect(new RuntimeEmbedder(nomicCfg).embedQuery('x')).resolves.toBeDefined();
    });

    it('does not meter a run whose vectors came from the wrong model', async () => {
      stubFetch((req) => ({ json: {
        model: 'other-model', usage: { prompt_tokens: 9, total_tokens: 9 },
        data: req.input.map((str, i) => ({ index: i, embedding: [hash(str)] })),
      } }));
      const embedder = new RuntimeEmbedder(nomicCfg);
      await expect(embedder.embedQuery('x')).rejects.toThrow(/ran on "other-model"/);
      expect(embedder.getUsage()).toMatchObject({ calls: 0 });
    });

    it('checks once per embedder, not once per batch', async () => {
      stubFetch(echo);
      const embedder = new RuntimeEmbedder(nomicCfg);
      await embedder.embedDocuments(Array.from({ length: 70 }, (_, n) => `x-${n}`)); // 64 + 6 → 2 batches
      await embedder.embedQuery('again');
      expect(urls.filter((u) => u.endsWith('/models'))).toHaveLength(1);
      expect(requests).toHaveLength(3);
    });
  });
});
