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

  it('env override with only EMBED_DOC_PREFIX treats query as empty', () => {
    expect(resolvePrefixes('all-minilm-l6-v2', { EMBED_DOC_PREFIX: 'passage: ' }))
      .toEqual({ query: '', doc: 'passage: ' });
  });

  it('an empty-string override disables a known model prefix', () => {
    // EMBED_QUERY_PREFIX='' is set-but-empty — the !== undefined check means it
    // wins over the supported set, deliberately turning the auto-prefix off.
    expect(resolvePrefixes('qwen3-embedding:0.6b', { EMBED_QUERY_PREFIX: '' }))
      .toEqual({ query: '', doc: '' });
  });

  it('matches a mixed-case model id (case-insensitive)', () => {
    expect(resolvePrefixes('Qwen3-Embedding-0.6B-GGUF', {}).query).toContain('Instruct:');
  });
});
