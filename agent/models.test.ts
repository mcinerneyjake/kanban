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

  it('Qwen3-Embedding prefixes the query only', () => {
    const cfg = resolveEmbedConfig({ EMBED_MODEL: 'qwen3-embedding:0.6b' });
    expect(cfg.queryInstruction).toContain('Instruct:');
    expect(cfg.docInstruction).toBe('');
  });

  it('nomic prefixes both sides', () => {
    const cfg = resolveEmbedConfig({ EMBED_MODEL: 'nomic-embed-text' });
    expect(cfg.queryInstruction).toBe('search_query: ');
    expect(cfg.docInstruction).toBe('search_document: ');
  });

  it('an unknown model gets no prefixes', () => {
    const cfg = resolveEmbedConfig({ EMBED_MODEL: 'some-other-model' });
    expect(cfg.queryInstruction).toBe('');
    expect(cfg.docInstruction).toBe('');
  });

  it('honors EMBED_QUERY_PREFIX / EMBED_DOC_PREFIX overrides for any model', () => {
    const cfg = resolveEmbedConfig({
      EMBED_MODEL: 'all-minilm-l6-v2', EMBED_QUERY_PREFIX: 'query: ', EMBED_DOC_PREFIX: 'passage: ',
    });
    expect(cfg.queryInstruction).toBe('query: ');
    expect(cfg.docInstruction).toBe('passage: ');
  });
});
