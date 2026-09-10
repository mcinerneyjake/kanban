import { type Embedder } from './retrieval.js';
import { type EmbeddingStore, hashText } from './embeddingStore.js';

// Decorates any Embedder with a persistent content-addressed cache (EmbeddingStore): unchanged text is served from the store, only new/changed text reaches the inner embedder. Queries pass straight through — caching one-offs would only bloat the store.

export class CachingEmbedder implements Embedder {
  // Hashes of the most recently embedded corpus — indexCache prunes the store to this set so removed/edited content doesn't linger.
  private lastCorpus: string[] = [];

  // `namespace` binds the key to the embedder's identity (model + doc-prefix): a model/prefix swap must yield a different key, never serve a stale (possibly wrong-dimension) vector. Empty ⇒ bare content hash (tests).
  constructor(
    private readonly inner: Embedder,
    private readonly store: EmbeddingStore,
    private readonly namespace = '',
  ) {}

  // `<nsHash>:<contentHash>` rather than one digest over namespace+text. Folding the namespace INTO
  // the digest made it unrecoverable from a key, so `prune` could not tell one namespace's entries
  // from another's and deleted everything outside the build that just ran — two consumers on
  // different EMBED_MODEL wiped each other every build (tkt-aa73a535ec4a). A plaintext prefix keeps
  // the same separation while leaving the namespace legible to the pruner.
  //
  // (The old form separated the two with a literal NUL byte — invisible in every diff and explained
  // by no comment. The prefix is the same idea made legible.)
  private key(text: string): string {
    return `${this.scope()}${hashText(text)}`;
  }

  /** Key prefix identifying this embedder's namespace; '' when unnamespaced. What `prune` scopes to. */
  scope(): string {
    return this.namespace ? `${hashText(this.namespace).slice(0, 16)}:` : '';
  }

  // Forwarded rather than omitted: a decorator that drops the seam silently removes the preflight
  // for anything wrapping it.
  verifyModel(): Promise<void> {
    return this.inner.verifyModel?.() ?? Promise.resolve();
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const hashes = texts.map((t) => this.key(t));

    // The served-model check lives behind the inner embedDocuments, which an all-hit corpus never
    // calls, so a warm cache skipped it entirely (tkt-29f830c3466f). RuntimeEmbedder memoizes a
    // fulfilled check, so this is once per embedder — the same guarantee the miss path already has,
    // measured, not assumed. Empty corpus is exempt: no vector is served, so nothing needs vouching.
    if (hashes.length > 0) await this.inner.verifyModel?.();

    // After the preflight: a build refused above must leave no corpus for `prune` to scope to.
    this.lastCorpus = hashes;

    // Unique misses in first-seen order — a text repeated within/across documents is embedded once, not per occurrence.
    const misses = new Map<string, string>(); // hash → its text
    hashes.forEach((hash, i) => {
      if (!this.store.has(hash) && !misses.has(hash)) misses.set(hash, texts[i]);
    });

    if (misses.size > 0) {
      const vectors = await this.inner.embedDocuments([...misses.values()]);
      // Guard the positional hash→vector mapping: a dropped/reordered batch would persist vectors under wrong keys, corrupting every future warm build (cache hits skip DocumentIndex's length check).
      if (vectors.length !== misses.size) {
        throw new Error(`CachingEmbedder: embedder returned ${vectors.length} vectors for ${misses.size} inputs`);
      }
      [...misses.keys()].forEach((hash, j) => this.store.set(hash, vectors[j]));
    }

    // Reassemble in input order, pulling every vector from the store.
    return hashes.map((hash) => {
      const vector = this.store.get(hash);
      if (!vector) throw new Error('CachingEmbedder: vector missing after embed');
      return vector;
    });
  }

  embedQuery(text: string): Promise<number[]> {
    return this.inner.embedQuery(text);
  }

  corpusHashes(): Set<string> {
    return new Set(this.lastCorpus);
  }
}
