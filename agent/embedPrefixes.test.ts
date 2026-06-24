import { describe, it, expect } from 'vitest';
import { resolvePrefixes } from './embedPrefixes.js';

describe('resolvePrefixes', () => {
  it('Qwen3-Embedding: query instruction, no doc prefix', () => {
    const p = resolvePrefixes('qwen3-embedding:0.6b', {});
    expect(p.query).toContain('Instruct:');
    expect(p.doc).toBe('');
  });

  it('matches regardless of runtime id decoration', () => {
    expect(resolvePrefixes('text-embedding-qwen3-embedding-0.6b', {}).query).toContain('Instruct:');
  });

  it('nomic: prefixes both sides', () => {
    expect(resolvePrefixes('nomic-embed-text', {})).toEqual({
      query: 'search_query: ', doc: 'search_document: ',
    });
  });

  it('unknown model: no prefixes (safe default)', () => {
    expect(resolvePrefixes('all-minilm-l6-v2', {})).toEqual({ query: '', doc: '' });
  });

  it('env override wins over the supported set', () => {
    expect(resolvePrefixes('nomic-embed-text', { EMBED_QUERY_PREFIX: 'q: ', EMBED_DOC_PREFIX: 'd: ' }))
      .toEqual({ query: 'q: ', doc: 'd: ' });
  });

  it('env override with only one var treats the other as empty', () => {
    expect(resolvePrefixes('all-minilm-l6-v2', { EMBED_QUERY_PREFIX: 'query: ' }))
      .toEqual({ query: 'query: ', doc: '' });
  });
});
