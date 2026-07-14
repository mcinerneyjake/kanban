import { describe, it, expect } from 'vitest';
import { buildTicketForm } from './intakeApply.js';
import { changedFormFields } from './ticketDiff.js';
import type { Ticket } from '../../shared/constants.js';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tkt-1', title: 'Login broken', type: 'bug', priority: 'medium', status: 'backlog',
    order: 1, created: '', updated: '', body: 'old body', project: null, blockers: [],
    parent: null, dueDate: null, assignee: null, ...over,
  };
}

describe('buildTicketForm', () => {
  it('builds the baseline from the ticket only (no prefill overlay)', () => {
    const t = ticket();
    const baseline = buildTicketForm(t, [t]);
    expect(baseline.title).toBe('Login broken');
    expect(baseline.body).toBe('old body');
    expect(baseline.status).toBe('backlog');
  });

  it('overlays the prefill on the form; untouched fields fall back to the ticket', () => {
    const t = ticket();
    const form = buildTicketForm(t, [t], { body: 'new repro', priority: 'high' });
    expect(form.body).toBe('new repro');
    expect(form.priority).toBe('high');
    expect(form.title).toBe('Login broken');
  });

  // The regression assertion for tkt-128ee05af9ba: form (with prefill) vs baseline
  // (without) must diff to the proposed change, not {}.
  it('makes an agent-proposed change a real diff vs the prefill-free baseline', () => {
    const t = ticket();
    const patch = changedFormFields(buildTicketForm(t, [t], { body: 'new repro' }), buildTicketForm(t, [t]));
    expect(patch.body).toBe('new repro');
  });

  it('produces an empty patch for an unchanged submit (no prefill)', () => {
    const t = ticket();
    expect(changedFormFields(buildTicketForm(t, [t]), buildTicketForm(t, [t]))).toEqual({});
  });

  it('overlays the prefill on defaults for a create (no ticket)', () => {
    const form = buildTicketForm(null, [], { title: 'New bug', type: 'bug' });
    expect(form.title).toBe('New bug');
    expect(form.type).toBe('bug');
    expect(form.status).toBe('backlog');
    expect(form.body).toBe('');
  });

  it('drops archived/dangling blockers from the seeded form', () => {
    const active = ticket({ id: 'tkt-active', status: 'todo' });
    const archived = ticket({ id: 'tkt-archived', status: 'archived' });
    const t = ticket({ blockers: ['tkt-active', 'tkt-archived', 'tkt-missing'] });
    expect(buildTicketForm(t, [active, archived]).blockers).toEqual(['tkt-active']);
  });

  it('seeds an active parent but drops an archived one', () => {
    const child = ticket({ parent: 'tkt-parent' });
    expect(buildTicketForm(child, [ticket({ id: 'tkt-parent', status: 'todo' })]).parent).toBe('tkt-parent');
    expect(buildTicketForm(child, [ticket({ id: 'tkt-parent', status: 'archived' })]).parent).toBeNull();
  });
});
