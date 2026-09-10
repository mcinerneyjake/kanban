import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CachingEmbedder } from './cachingEmbedder.js';
import { EmbeddingStore, hashText } from './embeddingStore.js';
import { type Embedder, RuntimeEmbedder } from './retrieval.js';
import { type EmbedConfig } from './models.js';

// Records which texts the inner embedder was actually asked to embed — the
// proxy for "did we re-embed this?". Returns a distinct vector per text so
// input-order reassembly is verifiable.
class RecordingEmbedder implements Embedder {
  public embedded: string[][] = []; // one entry per embedDocuments call
  embedDocuments(texts: string[]): Promise<number[][]> {
    this.embedded.push(texts);
    return Promise.resolve(texts.map((t) => [t.length]));
  }
  embedQuery(): Promise<number[]> { return Promise.resolve([0]); }
  get calls(): number { return this.embedded.length; }
  get totalTexts(): number { return this.embedded.reduce((n, c) => n + c.length, 0); }
}

// Inner embedder that also exposes the runtime's served-model preflight. `fail` makes that
// preflight refuse — the "runtime no longer serves EMBED_MODEL" / "could not list models" case a
// fully warm cache would otherwise never reach.
class VerifyingEmbedder extends RecordingEmbedder {
  public verifyCalls = 0;
  constructor(private readonly fail?: Error) { super(); }
  verifyModel(): Promise<void> {
    this.verifyCalls++;
    return this.fail ? Promise.reject(this.fail) : Promise.resolve();
  }
}

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caching-embedder-test-'));
  file = path.join(dir, 'embeddings.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('CachingEmbedder', () => {
  it('embeds every text on a cold cache, nothing on an identical second call', async () => {
    const store = await EmbeddingStore.load(file);
    const inner = new RecordingEmbedder();
    const embedder = new CachingEmbedder(inner, store);

    const first = await embedder.embedDocuments(['a', 'bb', 'ccc']);
    expect(first).toEqual([[1], [2], [3]]); // vector = text length, input order
    expect(inner.calls).toBe(1);

    const second = await embedder.embedDocuments(['a', 'bb', 'ccc']);
    expect(second).toEqual([[1], [2], [3]]); // served from the store
    expect(inner.calls).toBe(1); // inner NOT called again
  });

  it('embeds only the misses when part of the corpus is cached', async () => {
    const store = await EmbeddingStore.load(file);
    const inner = new RecordingEmbedder();
    const embedder = new CachingEmbedder(inner, store);

    await embedder.embedDocuments(['a', 'bb']); // warms a, bb
    await embedder.embedDocuments(['a', 'bb', 'ccc']); // only ccc is new

    expect(inner.embedded[1]).toEqual(['ccc']); // second call embedded just the miss
  });

  it('dedups a text repeated within one call, embedding it once', async () => {
    const store = await EmbeddingStore.load(file);
    const inner = new RecordingEmbedder();
    const embedder = new CachingEmbedder(inner, store);

    const out = await embedder.embedDocuments(['dup', 'dup', 'other']);
    expect(inner.embedded[0]).toEqual(['dup', 'other']); // 'dup' embedded once
    expect(out).toEqual([[3], [3], [5]]); // both 'dup' slots resolve to the same vector
  });

  it('passes queries straight through without caching', async () => {
    const store = await EmbeddingStore.load(file);
    const inner = new RecordingEmbedder();
    const embedder = new CachingEmbedder(inner, store);
    expect(await embedder.embedQuery('anything')).toEqual([0]);
    expect(inner.calls).toBe(0); // embedQuery doesn't touch embedDocuments
  });

  it('namespaces the key so different embedder identities never share a vector', async () => {
    const store = await EmbeddingStore.load(file);
    const innerA = new RecordingEmbedder();
    await new CachingEmbedder(innerA, store, 'model-A').embedDocuments(['shared text']);
    expect(innerA.calls).toBe(1); // cold under A

    const innerB = new RecordingEmbedder();
    await new CachingEmbedder(innerB, store, 'model-B').embedDocuments(['shared text']);
    expect(innerB.calls).toBe(1); // re-embedded under B — NOT served from A's vector
  });

  it('throws if the inner embedder returns the wrong number of vectors', async () => {
    const store = await EmbeddingStore.load(file);
    const broken: Embedder = {
      embedDocuments: (texts) => Promise.resolve(texts.slice(1).map(() => [1])),
      embedQuery: () => Promise.resolve([1]),
    };
    await expect(new CachingEmbedder(broken, store).embedDocuments(['a', 'b']))
      .rejects.toThrow(/returned 1 vectors for 2/);
  });

  it('corpusHashes reflects the most recent embedDocuments call', async () => {
    const store = await EmbeddingStore.load(file);
    const embedder = new CachingEmbedder(new RecordingEmbedder(), store);
    await embedder.embedDocuments(['x', 'y']);
    expect(embedder.corpusHashes()).toEqual(new Set([hashText('x'), hashText('y')]));
  });

  it('persists across a restart: a warm cache re-embeds nothing', async () => {
    // Cold process: embed + persist.
    const store1 = await EmbeddingStore.load(file);
    const inner1 = new RecordingEmbedder();
    await new CachingEmbedder(inner1, store1).embedDocuments(['a', 'bb', 'ccc']);
    await store1.persist();
    expect(inner1.totalTexts).toBe(3);

    // "Restart": a brand-new store loaded from the same file + a fresh inner.
    const store2 = await EmbeddingStore.load(file);
    const inner2 = new RecordingEmbedder();
    const out = await new CachingEmbedder(inner2, store2).embedDocuments(['a', 'bb', 'ccc']);
    expect(out).toEqual([[1], [2], [3]]); // served from disk
    expect(inner2.calls).toBe(0); // nothing re-embedded after restart
  });

  it('after a restart, only changed content is re-embedded', async () => {
    const store1 = await EmbeddingStore.load(file);
    await new CachingEmbedder(new RecordingEmbedder(), store1).embedDocuments(['a', 'bb']);
    await store1.persist();

    const store2 = await EmbeddingStore.load(file);
    const inner2 = new RecordingEmbedder();
    await new CachingEmbedder(inner2, store2).embedDocuments(['a', 'CHANGED']); // 'a' cached, second is new
    expect(inner2.embedded[0]).toEqual(['CHANGED']);
  });

  // tkt-29f830c3466f. A warm cache served vectors with no model check at all: the preflight lives in
  // RuntimeEmbedder.postBatch, which `misses.size > 0` gates, so an all-hit corpus skipped it.
  it('refuses a fully warm cache when the model can no longer be verified', async () => {
    const store = await EmbeddingStore.load(file);
    await new CachingEmbedder(new RecordingEmbedder(), store).embedDocuments(['a', 'bb']);

    const refusing = new VerifyingEmbedder(new Error('Embedding model "x" is not served'));
    const embedder = new CachingEmbedder(refusing, store);

    await expect(embedder.embedDocuments(['a', 'bb'])).rejects.toThrow('is not served');
    expect(refusing.calls).toBe(0); // refused before serving, and still nothing re-embedded
  });

  it('verifies once before serving, even when every text is a cache hit', async () => {
    const store = await EmbeddingStore.load(file);
    await new CachingEmbedder(new RecordingEmbedder(), store).embedDocuments(['a', 'bb']);

    const inner = new VerifyingEmbedder();
    const out = await new CachingEmbedder(inner, store).embedDocuments(['a', 'bb']);

    expect(out).toEqual([[1], [2]]);
    expect(inner.verifyCalls).toBe(1);
    expect(inner.calls).toBe(0); // verified without re-embedding
  });

  it('verifies before embedding when only some texts are cached', async () => {
    const store = await EmbeddingStore.load(file);
    await new CachingEmbedder(new RecordingEmbedder(), store).embedDocuments(['a']);

    const inner = new VerifyingEmbedder();
    await new CachingEmbedder(inner, store).embedDocuments(['a', 'NEW']);

    expect(inner.verifyCalls).toBe(1);
    expect(inner.embedded[0]).toEqual(['NEW']);
  });

  // Guard, not a repro: an empty corpus computes no vectors, so there is nothing to verify and no
  // runtime call is owed. Two tests in retrieval.test.ts pin the same shape one layer down.
  it('does not verify for an empty corpus', async () => {
    const store = await EmbeddingStore.load(file);
    const inner = new VerifyingEmbedder(new Error('should not be reached'));

    await expect(new CachingEmbedder(inner, store).embedDocuments([])).resolves.toEqual([]);
    expect(inner.verifyCalls).toBe(0);
  });

  // The seam stays optional: stubs and any non-runtime Embedder have no preflight to run.
  it('serves a warm cache from an embedder that cannot verify', async () => {
    const store = await EmbeddingStore.load(file);
    await new CachingEmbedder(new RecordingEmbedder(), store).embedDocuments(['a', 'bb']);

    const plain = new RecordingEmbedder();
    const out = await new CachingEmbedder(plain, store).embedDocuments(['a', 'bb']);

    expect(out).toEqual([[1], [2]]);
    expect(plain.calls).toBe(0);
  });
});

// Round trip over the REAL chain (CachingEmbedder -> RuntimeEmbedder -> fetch), stubbing only HTTP.
// The unit tests above drive a stub inner embedder, so they cannot show that RuntimeEmbedder's
// preflight is the thing actually reached on the warm path — which is the whole of tkt-29f830c3466f.
describe('CachingEmbedder + RuntimeEmbedder (round trip, mocked fetch)', () => {
  const cfg: EmbedConfig = {
    baseUrl: 'http://localhost:1234/v1',
    model: 'text-embedding-test',
    queryInstruction: '',
    docInstruction: '',
  };

  let urls: string[] = [];
  function stubRuntime(servedIds: string[]): void {
    urls = [];
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      return Promise.resolve(new Response(embedReply(url, servedIds, init), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }));
  }

  // Warms the store through the caching seam without touching the runtime.
  async function warmStore(): Promise<EmbeddingStore> {
    const store = await EmbeddingStore.load(file);
    await new CachingEmbedder(new RecordingEmbedder(), store).embedDocuments(['a', 'bb']);
    return store;
  }

  // Echoes one 1-d vector per input so a genuine cache MISS can be driven through the stub.
  function embedReply(url: string, servedIds: string[], init?: RequestInit): string {
    if (url.endsWith('/models')) return JSON.stringify({ data: servedIds.map((id) => ({ id })) });
    const raw: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const n = typeof raw === 'object' && raw !== null && 'input' in raw && Array.isArray(raw.input) ? raw.input.length : 0;
    return JSON.stringify({ model: cfg.model, data: Array.from({ length: n }, (_v, i) => ({ index: i, embedding: [i + 1] })) });
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('refuses a fully warm cache when the runtime does not serve the model, before any embeddings call', async () => {
    const store = await warmStore();
    stubRuntime(['some-other-model']);

    const embedder = new CachingEmbedder(new RuntimeEmbedder(cfg), store);

    await expect(embedder.embedDocuments(['a', 'bb'])).rejects.toThrow('is not served by the runtime');
    expect(urls.filter((u) => u.endsWith('/embeddings'))).toHaveLength(0);
  });

  it('serves a fully warm cache unchanged when the model IS served, with one models GET and no embeddings call', async () => {
    const store = await warmStore();
    stubRuntime([cfg.model]);

    const out = await new CachingEmbedder(new RuntimeEmbedder(cfg), store).embedDocuments(['a', 'bb']);

    expect(out).toEqual([[1], [2]]); // identical to what warmStore persisted
    expect(urls.filter((u) => u.endsWith('/models'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/embeddings'))).toHaveLength(0);
  });

  // Measured, not assumed: RuntimeEmbedder memoizes a FULFILLED check, so the preflight is once per
  // EMBEDDER, not once per build. Pinned here because the stub inner embedder above cannot show it,
  // and because the warm path must not be reported as stronger than the miss path — it is neither.
  it('preflights once per embedder, and a genuine miss re-probes no more than a warm build', async () => {
    const store = await warmStore();
    stubRuntime([cfg.model]);
    const runtime = new RuntimeEmbedder(cfg);

    await new CachingEmbedder(runtime, store).embedDocuments(['a', 'bb']);
    await new CachingEmbedder(runtime, store).embedDocuments(['a', 'bb']);
    const afterTwoWarmBuilds = urls.filter((u) => u.endsWith('/models')).length;

    await new CachingEmbedder(runtime, store).embedDocuments(['a', 'bb', 'NEW']);
    const afterAMiss = urls.filter((u) => u.endsWith('/models')).length;

    expect(afterTwoWarmBuilds).toBe(1);
    expect(afterAMiss).toBe(1);
    expect(urls.filter((u) => u.endsWith('/embeddings'))).toHaveLength(1); // only the miss embedded
  });

  it('forwards verifyModel so a decorator wrapping this one still preflights', async () => {
    const store = await warmStore();
    stubRuntime(['some-other-model']);

    const outer = new CachingEmbedder(new CachingEmbedder(new RuntimeEmbedder(cfg), store), store);

    await expect(outer.embedDocuments(['a', 'bb'])).rejects.toThrow('is not served by the runtime');
  });

  it('refuses a warm cache when the served list cannot be retrieved at all', async () => {
    const store = await warmStore();
    urls = [];
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
      urls.push(String(input));
      return Promise.reject(new TypeError('fetch failed'));
    }));

    const embedder = new CachingEmbedder(new RuntimeEmbedder(cfg), store);

    await expect(embedder.embedDocuments(['a', 'bb'])).rejects.toThrow('refusing to embed');
    expect(urls.filter((u) => u.endsWith('/embeddings'))).toHaveLength(0);
  });
});
