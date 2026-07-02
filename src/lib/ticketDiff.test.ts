import { describe, it, expect } from 'vitest';
import { changedFormFields, type TicketFormFields } from './ticketDiff.js';

function base(overrides: Partial<TicketFormFields> = {}): TicketFormFields {
  return {
    title: 'Original', type: 'task', priority: 'medium', status: 'in-progress',
    body: 'Body', project: null, blockers: [], parent: null, dueDate: null, assignee: null,
    ...overrides,
  };
}

describe('changedFormFields', () => {
  it('returns {} when nothing changed', () => {
    const b = base();
    expect(changedFormFields({ ...b }, b)).toEqual({});
  });

  it('returns only the changed field', () => {
    const b = base();
    expect(changedFormFields(base({ title: 'Fixed typo' }), b)).toEqual({ title: 'Fixed typo' });
  });

  it('omits an unchanged status even if it is stale (the core anti-clobber case)', () => {
    // Modal opened at status in-progress; the agent has since moved the real
    // ticket to qa. The user only edits the title. status must NOT be in the diff
    // (so the PATCH cannot revert the agent's transition).
    const b = base({ status: 'in-progress' });
    const form = base({ status: 'in-progress', title: 'New title' });
    expect(changedFormFields(form, b)).toEqual({ title: 'New title' });
  });

  it('includes multiple changed fields, including to/from null', () => {
    const b = base({ project: 'kanban', assignee: 'jake' });
    const form = base({ project: 'other', assignee: null, priority: 'high' });
    expect(changedFormFields(form, b)).toEqual({ project: 'other', assignee: null, priority: 'high' });
  });

  it('covers the remaining scalar fields (type / body / parent / dueDate)', () => {
    const b = base({ parent: 'tkt-p', dueDate: '2026-01-01' });
    const form = base({ type: 'bug', body: 'New body', parent: null, dueDate: '2026-02-02' });
    expect(changedFormFields(form, b)).toEqual({
      type: 'bug', body: 'New body', parent: null, dueDate: '2026-02-02',
    });
  });

  it('detects blocker content changes and ignores an unchanged blocker list', () => {
    const b = base({ blockers: ['a', 'b'] });
    expect(changedFormFields(base({ blockers: ['a', 'b'] }), b)).toEqual({});
    expect(changedFormFields(base({ blockers: ['a'] }), b)).toEqual({ blockers: ['a'] });
    expect(changedFormFields(base({ blockers: ['a', 'b', 'c'] }), b)).toEqual({ blockers: ['a', 'b', 'c'] });
  });
});
