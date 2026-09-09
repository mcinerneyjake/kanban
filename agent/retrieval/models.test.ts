import { describe, it, expect } from 'vitest';
import { resolveEmbedConfig } from './models.js';

describe('resolveEmbedConfig', () => {
  // The default must be the id the RUNTIME advertises, not the Ollama-style `qwen3-embedding:0.6b`
  // this used to carry: LM Studio answers 200 for an id it does not serve and silently substitutes a
  // different model, so the old default embedded with 768-d nomic while callers believed they had
  // 1024-d qwen3 (tkt-01b784eb0030). RuntimeEmbedder's preflight is what actually enforces this; the
  // assertion here keeps the default from drifting back to a spelling no runtime serves.
  it('defaults base URL + model when env is empty', () => {
    const cfg = resolveEmbedConfig({});
    expect(cfg.baseUrl).toBe('http://localhost:1234/v1');
    expect(cfg.model).toBe('text-embedding-qwen3-embedding-0.6b');
  });

  // The rename must not silently change the prefix profile: embedPrefixes matches by SUBSTRING
  // ('qwen3-embedding'), which both spellings contain. A default that stopped matching would ship an
  // un-prefixed query against a model trained to expect one, and only retrieval quality would show it.
  it('keeps the Qwen3 prefix profile under the corrected default spelling', () => {
    expect(resolveEmbedConfig({}).queryInstruction).toBe(
      resolveEmbedConfig({ EMBED_MODEL: 'qwen3-embedding:0.6b' }).queryInstruction,
    );
    expect(resolveEmbedConfig({}).queryInstruction).toMatch(/^Instruct: /);
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
