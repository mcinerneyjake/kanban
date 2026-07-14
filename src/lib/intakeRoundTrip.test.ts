import { describe, it, expect } from 'vitest';
import { setupTempTicketDirs } from '../../test-support/tempTicketDirs.js';
import { proposeIntake } from '../../agent/runtime/propose.js';
import { DocumentIndex, type Embedder, type Document } from '../../agent/retrieval/retrieval.js';
import type { ChatMessage, ChatClient } from '../../agent/runtime/llm.js';
import type { ChatTool } from '../../agent/runtime/tools.js';
import { createTicket, updateTicket, getTicket } from '../../server/tickets.js';
import { changedFormFields } from './ticketDiff.js';
import { resolveProposalPlan, buildTicketForm } from './intakeApply.js';

// END-TO-END round-trip test for the in-app intake seam: the regression net for
// the propose→apply chain (proposeIntake → resolveProposalPlan → proposalToPrefill
// → changedFormFields → create/update → persist). It drives the REAL chain
// headlessly (a scripted chat fake stands in for the local model). See CLAUDE.md
// → Testing → "Integration seams" and the memory feedback_integration_seam_review_testing.
//
// `it.fails` cases document CONFIRMED bugs whose fixes are queued: the assertion
// states the DESIRED behavior, so it currently fails (→ it.fails passes, gate stays
// green) and, once the bug is fixed, passes (→ it.fails FAILS, forcing a flip to
// it()). `it.todo` marks invariants whose code doesn't exist yet.

// A scripted ChatClient: returns canned replies in order (last reply repeats). No
// network — the same no-model approach as agent/replay/replayRecorder.test.ts.
class ScriptedChat implements ChatClient {
  private i = 0;
  constructor(private readonly replies: ChatMessage[]) {}
  complete(_messages: ChatMessage[], _tools: ChatTool[]): Promise<ChatMessage> {
    const reply = this.replies[Math.min(this.i, this.replies.length - 1)];
    this.i += 1;
    return Promise.resolve(reply);
  }
}

// The index is a required dep but never queried here (the scripted model goes
// straight to a mutation, skipping search_board), so a constant vector suffices.
class StubEmbedder implements Embedder {
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map(() => [1, 0, 0])); }
  embedQuery(_text: string): Promise<number[]> { return Promise.resolve([1, 0, 0]); }
}

function doc(id: string, title: string): Document {
  return { id, source: 'ticket', title, text: title, meta: { status: 'backlog' } };
}

function toolCallReply(name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

const finalReply: ChatMessage = { role: 'assistant', content: 'Done.' };

async function newIndex(): Promise<DocumentIndex> {
  return DocumentIndex.build(new StubEmbedder(), [doc('seed', 'seed')]);
}

describe('intake propose→apply round-trip', () => {
  setupTempTicketDirs('intake-round-trip');

  it('round-trips a create proposal into a persisted ticket (fidelity)', async () => {
    const args = { title: 'Export button 500s', body: 'Clicking export returns a 500', type: 'bug', priority: 'high' };
    const chat = new ScriptedChat([toolCallReply('create_ticket', args), finalReply]);
    const { proposal } = await proposeIntake('the export button 500s', { chat, index: await newIndex() });
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    const plan = resolveProposalPlan(proposal, []);
    expect(plan.mode).toBe('create');

    // The create form submits the whole form (defaults + prefill).
    const created = await createTicket({ status: 'backlog', ...plan.prefill });
    const persisted = await getTicket(created.id);
    expect(persisted.title).toBe(args.title);
    expect(persisted.body).toBe(args.body);
    expect(persisted.type).toBe('bug');
    expect(persisted.priority).toBe('high');
  });

  it('round-trips an update proposal through the modal form builders and persists the change', async () => {
    const existing = await createTicket({ title: 'Login is broken', body: 'old body', type: 'bug', priority: 'medium', status: 'backlog' });
    const chat = new ScriptedChat([toolCallReply('update_ticket', { id: existing.id, body: 'Repro: click login then 500' }), finalReply]);
    const { proposal } = await proposeIntake('login 500', { chat, index: await newIndex() });
    if (!proposal) throw new Error('expected a proposal');

    const plan = resolveProposalPlan(proposal, [existing]); // the real modal routing decision
    expect(plan.mode).toBe('update');
    if (plan.mode !== 'update') return;
    expect(plan.target.id).toBe(existing.id);

    // Drive the modal's REAL builders: `form` overlays the prefill, `baseline` does NOT.
    // If baseline still folded the prefill in (Bug D, tkt-128ee05af9ba) the diff would be
    // {} and the body would never persist — so this asserts the fix end-to-end.
    const patch = changedFormFields(
      buildTicketForm(plan.target, [existing], plan.prefill),
      buildTicketForm(plan.target, [existing]),
    );
    expect(patch.body).toBe('Repro: click login then 500');
    await updateTicket(plan.target.id, patch);
    expect((await getTicket(plan.target.id)).body).toBe('Repro: click login then 500');
  });

  // tkt-1dfa61b8830e (Bug E, FIXED): an update proposal whose id isn't loaded resolves
  // to 'not-found', NOT 'create' (which would silently draft a duplicate).
  it('an update proposal with an unknown id resolves to not-found, not create', () => {
    const plan = resolveProposalPlan({ action: 'update_ticket', args: { id: 'tkt-ghost-9999', body: 'x' } }, []);
    expect(plan.mode).toBe('not-found');
  });

  // EXPECTED FAIL until tkt-727c5cacdfad (Bug G). Flip `it.fails` → `it` when fixed.
  it.fails('G: a create proposal with status qa yields a prefill createTicket accepts', async () => {
    const plan = resolveProposalPlan({ action: 'create_ticket', args: { title: 'X', status: 'qa' } }, []);
    // Today prefill.status === 'qa' → createTicket rejects with 400 (qa is not create-valid).
    await expect(createTicket({ status: 'backlog', ...plan.prefill })).resolves.toBeTruthy();
  });

  // EXPECTED FAIL until tkt-727c5cacdfad (Bug H). Flip `it.fails` → `it` when fixed.
  it.fails('H: an agent-proposed assignee survives into the persisted ticket', async () => {
    const plan = resolveProposalPlan({ action: 'create_ticket', args: { title: 'Bug for Alice', assignee: 'Alice', dueDate: '2026-07-20' } }, []);
    // proposalToPrefill drops assignee/dueDate today, so the create form never carries them.
    const created = await createTicket({ status: 'backlog', ...plan.prefill });
    const persisted = await getTicket(created.id);
    expect(persisted.assignee).toBe('Alice');
  });

  // TODO(tkt-67de93c44726 / tkt-7aa8c73735a9, Bugs A+B): once an intake-apply endpoint
  // exists, applying a proposal stamps {source:agent, runId} provenance and appends a
  // run record. Activate when that endpoint lands.
  it.todo('A/B: an intake-apply stamps agent provenance and records the run');
});
