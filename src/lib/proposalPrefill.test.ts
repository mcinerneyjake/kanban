import { describe, it, expect } from 'vitest';
import { proposalToPrefill, proposalTargetId } from './proposalPrefill.js';

describe('proposalToPrefill', () => {
  it('keeps valid fields', () => {
    expect(proposalToPrefill({ title: 'PDF bug', type: 'bug', priority: 'high', status: 'todo', body: 'repro' }))
      .toEqual({ title: 'PDF bug', type: 'bug', priority: 'high', status: 'todo', body: 'repro' });
  });

  it('drops fields with invalid enum values', () => {
    expect(proposalToPrefill({ title: 'x', type: 'banana', priority: 'critical', status: 'nope' }))
      .toEqual({ title: 'x' });
  });

  it('filters per-field — keeps valid enums alongside invalid ones', () => {
    expect(proposalToPrefill({ type: 'bug', priority: 'nope', status: 'todo' }))
      .toEqual({ type: 'bug', status: 'todo' });
  });

  it('drops non-string title / body', () => {
    expect(proposalToPrefill({ title: 123, body: { x: 1 } })).toEqual({});
  });

  it('returns {} for empty args', () => {
    expect(proposalToPrefill({})).toEqual({});
  });
});

describe('proposalTargetId', () => {
  it('returns the id for an update proposal', () => {
    expect(proposalTargetId({ action: 'update_ticket', args: { id: 'tkt-1' } })).toBe('tkt-1');
  });

  it('returns null for a create proposal', () => {
    expect(proposalTargetId({ action: 'create_ticket', args: { title: 'x' } })).toBeNull();
  });

  it('returns null for an update with no id', () => {
    expect(proposalTargetId({ action: 'update_ticket', args: {} })).toBeNull();
  });

  it('returns null for an update with a non-string id', () => {
    expect(proposalTargetId({ action: 'update_ticket', args: { id: 123 } })).toBeNull();
  });
});
