import { describe, it, expect } from 'vitest';
import { resolveEmbedConfig } from './models.js';

describe('resolveEmbedConfig', () => {
  it('defaults base URL + model when env is empty', () => {
    const cfg = resolveEmbedConfig({});
    expect(cfg.baseUrl).toBe('http://localhost:1234/v1');
    expect(cfg.model).toBe('qwen3-embedding:0.6b');
  });

  it('strips a trailing slash from the base URL', () => {
    expect(resolveEmbedConfig({ EMBED_BASE_URL: 'http://x/v1/' }).baseUrl).toBe('http://x/v1');
  });

  it('strips multiple trailing slashes from the base URL', () => {
    expect(resolveEmbedConfig({ EMBED_BASE_URL: 'http://x/v1///' }).baseUrl).toBe('http://x/v1');
  });

  // Per-model prefix behaviour (Qwen3/nomic/unknown/env-override) is owned in
  // full by embedPrefixes.test.ts. resolveEmbedConfig only delegates to
  // resolvePrefixes; these two smokes pin the delegation wiring — both args must
  // be forwarded, not just called.

  // The MODEL arg reaches resolvePrefixes: a known model resolves its prefixes.
  it('forwards the model to resolvePrefixes', () => {
    const cfg = resolveEmbedConfig({ EMBED_MODEL: 'nomic-embed-text' });
    expect(cfg.queryInstruction).toBe('search_query: ');
    expect(cfg.docInstruction).toBe('search_document: ');
  });

  // The ENV arg reaches resolvePrefixes: an override wins over the model default
  // (guards against a refactor to resolvePrefixes(model) that silently no-ops
  // EMBED_QUERY_PREFIX / EMBED_DOC_PREFIX).
  it('forwards env overrides to resolvePrefixes', () => {
    const cfg = resolveEmbedConfig({
      EMBED_MODEL: 'nomic-embed-text', EMBED_QUERY_PREFIX: 'q: ', EMBED_DOC_PREFIX: 'd: ',
    });
    expect(cfg.queryInstruction).toBe('q: ');
    expect(cfg.docInstruction).toBe('d: ');
  });
});
