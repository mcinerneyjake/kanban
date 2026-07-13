import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { isTrace, isTraceStep, isLlmCallStep, isRetrievalStep } from './replayTrace.js';

describe('isTraceStep', () => {
  it('accepts each known step type', () => {
    expect(isTraceStep({ type: 'note', text: 'hi' })).toBe(true);
    expect(isTraceStep({ type: 'retrieval', query: 'q', limit: 5, ms: 12, hits: [{ id: 't1', title: 'T', score: 0.9 }] })).toBe(true);
    expect(isTraceStep({ type: 'llm_call', content: 'hello', toolCalls: [], ms: 30 })).toBe(true);
    expect(isTraceStep({
      type: 'llm_call', content: null, ms: 30,
      toolCalls: [{ name: 'search_board', args: { query: 'x' } }],
      tokens: { prompt: 10, completion: 5, total: 15 },
    })).toBe(true);
    expect(isTraceStep({ type: 'approval', action: 'create_ticket', args: { title: 'X' }, decision: 'approved', reviewMs: 100 })).toBe(true);
    expect(isTraceStep({ type: 'final', text: 'done', createdIds: ['tkt-1'], updatedIds: [] })).toBe(true);
  });

  it('accepts an unknown step type as the generic fallback (schema not welded shut)', () => {
    expect(isTraceStep({ type: 'sql', sql: 'SELECT 1', rowCount: 3 })).toBe(true);
    expect(isTraceStep({ type: 'chart' })).toBe(true);
  });

  it('rejects non-objects and a missing / non-string type', () => {
    expect(isTraceStep(null)).toBe(false);
    expect(isTraceStep('note')).toBe(false);
    expect(isTraceStep({})).toBe(false);
    expect(isTraceStep({ type: 5 })).toBe(false);
  });

  it('rejects a malformed KNOWN step rather than passing it off as generic', () => {
    expect(isTraceStep({ type: 'note' })).toBe(false);                 // missing text
    expect(isTraceStep({ type: 'note', text: 5 })).toBe(false);        // wrong type
    expect(isTraceStep({ type: 'retrieval', query: 'q', limit: 5, ms: 1, hits: [{ id: 't', title: 'T' }] })).toBe(false); // hit missing score
    expect(isTraceStep({ type: 'llm_call', content: 'x', ms: 1, toolCalls: [{ args: {} }] })).toBe(false); // toolCall missing name
    expect(isTraceStep({ type: 'approval', action: 'x', args: {}, decision: 'maybe', reviewMs: 0 })).toBe(false); // bad decision
    expect(isTraceStep({ type: 'final', text: 'd', createdIds: 'nope', updatedIds: [] })).toBe(false); // createdIds not string[]
  });
});

describe('per-type predicates narrow precisely', () => {
  it('isLlmCallStep only matches llm_call and exposes typed fields', () => {
    const step: unknown = { type: 'llm_call', content: 'hi', ms: 5, toolCalls: [], tokens: { prompt: 1, completion: 2, total: 3 } };
    expect(isLlmCallStep(step)).toBe(true);
    expect(isRetrievalStep(step)).toBe(false);
    if (isLlmCallStep(step)) {
      // narrowed to LlmCallStep — no cast needed
      expect(step.tokens?.total).toBe(3);
      expect(step.ms).toBe(5);
    }
  });
});

describe('isTrace', () => {
  const meta = { runId: 'r1', at: '2026-01-01T00:00:00.000Z', model: 'm', kind: 'intake', input: 'note' };
  const step = { type: 'note', text: 'hi' };

  it('accepts a well-formed trace, with and without optional meta fields', () => {
    expect(isTrace({ meta, steps: [step] })).toBe(true);
    expect(isTrace({
      meta: {
        ...meta,
        outcome: { created: 1, updated: 0, declined: 0 },
        totals: { promptTokens: 1, completionTokens: 1, totalTokens: 2, calls: 1, reportedCalls: 1, activeMs: 10 },
      },
      steps: [],
    })).toBe(true);
  });

  it('rejects a missing / invalid meta or non-array steps', () => {
    expect(isTrace({ steps: [] })).toBe(false);
    expect(isTrace({ meta: { ...meta, runId: 5 }, steps: [] })).toBe(false);
    expect(isTrace({ meta, steps: 'nope' })).toBe(false);
    expect(isTrace({ meta: { ...meta, totals: { promptTokens: 'x' } }, steps: [] })).toBe(false);
  });

  it('rejects a trace containing a malformed step', () => {
    expect(isTrace({ meta, steps: [step, { type: 'note' }] })).toBe(false);
  });
});

// A hand-authored, board-content-free sample trace doubles as executable schema
// documentation (the shape the future viewer renders) and a guard against a
// hand-edit that breaks it. The REAL demo recordings live with their consumer —
// the portfolio site's public/traces/ (see tkt-a413c440b1e7) — not this repo.
describe('the sample trace fixture satisfies the schema', () => {
  it('test-support/sampleTrace.json is a valid Trace', () => {
    const raw: unknown = JSON.parse(fs.readFileSync('test-support/sampleTrace.json', 'utf8'));
    expect(isTrace(raw)).toBe(true);
  });
});
