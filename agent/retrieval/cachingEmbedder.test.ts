import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CachingEmbedder } from './cachingEmbedder.js';
import { EmbeddingStore, hashText } from './embeddingStore.js';
import { type Embedder } from './retrieval.js';

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
});
