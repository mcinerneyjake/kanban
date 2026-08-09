import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmbeddingStore, hashText } from './embeddingStore.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'embedding-store-test-'));
  file = path.join(dir, 'embeddings.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('hashText', () => {
  it('is deterministic for the same text', () => {
    expect(hashText('hello world')).toBe(hashText('hello world'));
  });
  it('differs for different text', () => {
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('EmbeddingStore', () => {
  it('returns an empty store when the file does not exist', async () => {
    const store = await EmbeddingStore.load(file);
    expect(store.size).toBe(0);
    expect(store.has(hashText('x'))).toBe(false);
  });

  it('persists vectors and reloads them across a restart', async () => {
    const store = await EmbeddingStore.load(file);
    store.set(hashText('alpha'), [1, 2, 3]);
    store.set(hashText('beta'), [4, 5, 6]);
    await store.persist();

    // A fresh load from the same path == a new process reading the warm cache.
    const reloaded = await EmbeddingStore.load(file);
    expect(reloaded.size).toBe(2);
    expect(reloaded.get(hashText('alpha'))).toEqual([1, 2, 3]);
    expect(reloaded.get(hashText('beta'))).toEqual([4, 5, 6]);
  });

  it('starts empty when the file is corrupt (never fatal)', async () => {
    await fs.writeFile(file, 'not json {{{');
    const store = await EmbeddingStore.load(file);
    expect(store.size).toBe(0);
  });

  it('starts empty when the file has the wrong shape', async () => {
    await fs.writeFile(file, JSON.stringify({ a: 'not-a-vector' }));
    const store = await EmbeddingStore.load(file);
    expect(store.size).toBe(0);
  });

  it('rejects a file with an empty vector (would crash cosine downstream)', async () => {
    await fs.writeFile(file, JSON.stringify({ h1: [1, 2], h2: [] }));
    expect((await EmbeddingStore.load(file)).size).toBe(0);
  });

  it('rejects a file with ragged (mixed-dimension) vectors', async () => {
    await fs.writeFile(file, JSON.stringify({ h1: [1, 2, 3], h2: [1] }));
    expect((await EmbeddingStore.load(file)).size).toBe(0);
  });

  it('prune drops entries not in the keep set', async () => {
    const store = await EmbeddingStore.load(file);
    store.set(hashText('keep'), [1]);
    store.set(hashText('drop'), [2]);
    store.prune(new Set([hashText('keep')]));
    expect(store.has(hashText('keep'))).toBe(true);
    expect(store.has(hashText('drop'))).toBe(false);
    expect(store.size).toBe(1);
  });

  it('persist is a no-op when nothing changed (no file written)', async () => {
    const store = await EmbeddingStore.load(file); // nothing set
    await store.persist();
    await expect(fs.access(file)).rejects.toThrow(); // never created
  });

  it('persist writes pruned state to disk', async () => {
    const store = await EmbeddingStore.load(file);
    store.set(hashText('keep'), [1]);
    store.set(hashText('drop'), [2]);
    store.prune(new Set([hashText('keep')]));
    await store.persist();

    const reloaded = await EmbeddingStore.load(file);
    expect(reloaded.size).toBe(1);
    expect(reloaded.has(hashText('drop'))).toBe(false);
  });

  // tkt-9f09b3a1e95c: the server and the CLI now share one cache file, so this store has
  // two writers. A fixed `${file}.tmp` meant concurrent persists wrote the same temp path —
  // one rename could land a partially-overwritten temp file.
  it('concurrent persists to the same file leave a valid, loadable cache', async () => {
    const a = await EmbeddingStore.load(file);
    const b = await EmbeddingStore.load(file);
    a.set(hashText('from-a'), [1, 0, 0]);
    b.set(hashText('from-b'), [0, 1, 0]);

    await Promise.all([a.persist(), b.persist()]);

    const reloaded = await EmbeddingStore.load(file);
    // Last writer wins on content (they hold independent maps); the invariant under test is
    // that the file is never corrupt — a torn write reloads as an EMPTY store, not a full one.
    expect(reloaded.size).toBeGreaterThan(0);
  });
});
