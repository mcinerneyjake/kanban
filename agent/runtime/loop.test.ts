import { describe, it, expect } from 'vitest';
import { setupTempTicketDirs } from '../../test-support/tempTicketDirs.js';
import { runIntake, SYSTEM_PROMPT_CREATE_ONLY } from './loop.js';
import { type ChatClient, type ChatMessage, type ToolCall } from './llm.js';
import { type ChatTool } from './tools.js';
import { DocumentIndex, type Embedder } from '../retrieval/retrieval.js';
import { listTickets, createTicket, getTicket } from '../../server/tickets.js';

// Stub embedder: every text maps to the same vector — ranking is irrelevant
// here, the loop tests only care about dispatch/termination mechanics.
class StubEmbedder implements Embedder {
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map(() => [1, 0, 0])); }
  embedQuery(): Promise<number[]> { return Promise.resolve([1, 0, 0]); }
}
const buildIndex = (): Promise<DocumentIndex> =>
  DocumentIndex.build(new StubEmbedder(), [
    { id: 't1', source: 'ticket', title: 'Existing login bug', text: 'Existing login bug' },
  ]);

const assistant = (content: string | null, tool_calls?: ToolCall[]): ChatMessage => ({ role: 'assistant', content, tool_calls });
const toolCall = (id: string, name: string, args: string): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

// A ChatClient that replays a fixed script of assistant turns.
class ScriptedChat implements ChatClient {
  public calls = 0;
  public sawTools = false;
  public lastToolNames: string[] = [];
  constructor(private readonly turns: ChatMessage[]) {}
  complete(_messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> {
    if (tools.length > 0) this.sawTools = true;
    this.lastToolNames = tools.map((t) => t.function.name);
    const turn = this.turns[this.calls] ?? assistant('(no more turns)');
    this.calls++;
    return Promise.resolve(turn);
  }
}

// runIntake drives handleToolCall (via create_ticket/list_tickets), which
// touches the service — redirect tickets + telemetry I/O to isolated temp dirs.
// The events dir matters here: an approved status-changing update emits .jsonl
// telemetry that a real id would otherwise write to the real events/ dir
// (currently only masked by a 404).
setupTempTicketDirs('agent-loop-test');

describe('runIntake', () => {
  it('seeds the conversation with a system prompt and the user input', async () => {
    const chat = new ScriptedChat([assistant('ok')]);
    const result = await runIntake('my report', { chat, index: await buildIndex() });
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[1]).toMatchObject({ role: 'user', content: 'my report' });
  });

  it('returns immediately when the model answers without tools', async () => {
    const chat = new ScriptedChat([assistant('just an answer')]);
    const result = await runIntake('hi', { chat, index: await buildIndex() });
    expect(result.final).toBe('just an answer');
    expect(result.steps).toBe(1);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('substitutes a fallback when the model returns an empty final', async () => {
    for (const empty of [null, '', '   ']) {
      const chat = new ScriptedChat([assistant(empty)]);
      const result = await runIntake('x', { chat, index: await buildIndex() });
      expect(result.final.trim().length).toBeGreaterThan(0);
    }
  });

  it('runs a tool call, feeds the result back, then returns the final answer', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '{"query":"login"}')]),
      assistant('Found t1; updated it.'),
    ]);
    const result = await runIntake('login is broken', { chat, index: await buildIndex() });
    expect(result.final).toBe('Found t1; updated it.');
    expect(result.steps).toBe(2);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(chat.sawTools).toBe(true);
  });

  it('links each tool result to its call via tool_call_id, after the assistant turn', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('call-42', 'search_board', '{"query":"x"}')]),
      assistant('done'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex() });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('call-42');
    const assistantIdx = result.messages.findIndex((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0);
    const toolIdx = result.messages.findIndex((m) => m.role === 'tool');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeLessThan(toolIdx);
  });

  it('dispatches multiple tool calls in a single turn', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '{"query":"a"}'), toolCall('c2', 'search_board', '{"query":"b"}')]),
      assistant('done'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex() });
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(result.final).toBe('done');
  });

  it('creates a ticket end-to-end through the loop', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"From the agent"}')]),
      assistant('Created it.'),
    ]);
    const result = await runIntake('please add a task', { chat, index: await buildIndex() });
    expect(result.final).toBe('Created it.');
    const board = await listTickets();
    expect(board.some((t) => t.title === 'From the agent')).toBe(true);
  });

  it('create-only mode uses the create-only prompt and offers no update_ticket tool', async () => {
    const chat = new ScriptedChat([assistant('done')]);
    const result = await runIntake('a report', { chat, index: await buildIndex(), createOnly: true });
    expect(result.messages[0].content).toBe(SYSTEM_PROMPT_CREATE_ONLY);
    expect(chat.lastToolNames).not.toContain('update_ticket');
    expect(chat.lastToolNames).toContain('create_ticket');
  });

  it('create-only mode refuses an update_ticket call and leaves the target body intact', async () => {
    const existing = await createTicket({ title: 'Existing', body: 'ORIGINAL — must survive' });
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'update_ticket', `{"id":"${existing.id}","body":"CLOBBERED"}`)]),
      assistant('Could not update; nothing changed.'),
    ]);
    const result = await runIntake('rewrite that ticket', { chat, index: await buildIndex(), createOnly: true, approve: () => true });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('not available');
    expect((await getTicket(existing.id)).body).toBe('ORIGINAL — must survive');
    expect(result.updatedIds).toHaveLength(0);
  });

  it('mints a runId and returns it on the result', async () => {
    const result = await runIntake('hi', { chat: new ScriptedChat([assistant('done')]), index: await buildIndex() });
    expect(typeof result.runId).toBe('string');
    expect(result.runId.length).toBeGreaterThan(0);
  });

  it('captures created ticket ids and stamps them with the run provenance', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"Agent authored"}')]),
      assistant('Created it.'),
    ]);
    const result = await runIntake('add it', { chat, index: await buildIndex(), runId: 'run-fixed' });
    expect(result.createdIds).toHaveLength(1);
    expect(result.runId).toBe('run-fixed');
    // The created ticket carries the run's provenance in its frontmatter.
    const board = await listTickets();
    const created = board.find((t) => t.title === 'Agent authored');
    expect(created?.source).toBe('agent');
    expect(created?.runId).toBe('run-fixed');
    expect(result.createdIds[0]).toBe(created?.id);
  });

  it('does not capture an id for a failed (errored) create', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{}')]), // no title → 400 → isError
      assistant('nothing created'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex() });
    expect(result.createdIds).toHaveLength(0);
  });

  it('tolerates malformed tool arguments (surfaces the tool error)', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', 'not json')]),
      assistant('handled'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex() });
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('query');
    expect(result.final).toBe('handled');
  });

  it('treats valid-but-non-object tool arguments as missing', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '[1,2,3]')]),
      assistant('handled'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex() });
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('query');
  });

  it('returns an errored outcome (not a throw) when the step budget is exhausted', async () => {
    const chat: ChatClient = {
      complete: () => Promise.resolve(assistant(null, [toolCall('c', 'search_board', '{"query":"x"}')])),
    };
    const result = await runIntake('x', { chat, index: await buildIndex(), maxSteps: 3 });
    // Return, don't throw — preserving the outcome/usage of whatever ran first.
    expect(result.outcome.errored).toBe(true);
    expect(result.steps).toBe(3);
    expect(result.final).toMatch(/within 3 steps/);
  });

  // --- human-in-the-loop approval gate (Phase 4) ---

  it('gates a mutating tool — rejection prevents the write', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"Should not exist"}')]),
      assistant('skipped it'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => false });
    const board = await listTickets();
    expect(board.some((t) => t.title === 'Should not exist')).toBe(false);
    expect(result.messages.find((m) => m.role === 'tool')?.content).toMatch(/declined/i);
    // the loop continues past the decline to a clean final answer
    expect(result.final).toBe('skipped it');
  });

  it('awaits an async approval callback (the CLI path)', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"Async gated"}')]),
      assistant('ok'),
    ]);
    await runIntake('x', { chat, index: await buildIndex(), approve: () => Promise.resolve(false) });
    expect((await listTickets()).some((t) => t.title === 'Async gated')).toBe(false);
  });

  it('gates any non-read-only tool by default (fail-safe)', async () => {
    let prompted = 0;
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'delete_ticket', '{"id":"t1"}')]),
      assistant('done'),
    ]);
    await runIntake('x', { chat, index: await buildIndex(), approve: () => { prompted++; return false; } });
    expect(prompted).toBe(1); // delete_ticket isn't read-only -> gated by default
  });

  it('gates only the mutating call in a mixed turn — reads run freely', async () => {
    let prompts = 0;
    const chat = new ScriptedChat([
      assistant(null, [
        toolCall('c1', 'search_board', '{"query":"x"}'),
        toolCall('c2', 'create_ticket', '{"title":"Mixed turn"}'),
      ]),
      assistant('done'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => { prompts++; return false; } });
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(2); // both produced a result
    expect(prompts).toBe(1); // only the write was gated
    expect((await listTickets()).some((t) => t.title === 'Mixed turn')).toBe(false);
  });

  it('executes a mutating tool when approve returns true', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"Approved ticket"}')]),
      assistant('created'),
    ]);
    await runIntake('x', { chat, index: await buildIndex(), approve: () => true });
    const board = await listTickets();
    expect(board.some((t) => t.title === 'Approved ticket')).toBe(true);
  });

  it('does not gate read-only tools (approve never called)', async () => {
    let asked = 0;
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '{"query":"x"}')]),
      assistant('done'),
    ]);
    await runIntake('x', { chat, index: await buildIndex(), approve: () => { asked++; return true; } });
    expect(asked).toBe(0);
  });

  it('passes the tool name and parsed args to approve', async () => {
    const seen: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'update_ticket', '{"id":"t1","title":"New"}')]),
      assistant('done'),
    ]);
    await runIntake('x', {
      chat, index: await buildIndex(),
      approve: (name, args) => { seen.push({ name, args }); return false; },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('update_ticket');
    expect(seen[0].args).toMatchObject({ id: 't1', title: 'New' });
  });

  // --- run outcome (feeds the cost epic's unit economics) ---

  it('reports outcome: created when a create is approved', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"Outcome created"}')]),
      assistant('created'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => true });
    expect(result.outcome).toMatchObject({ created: 1, updated: 0, declined: 0, noProposal: false });
  });

  it('reports outcome: updated when an update is approved', async () => {
    const seeded = await createTicket({ title: 'Seed to update' }); // a real file to update
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'update_ticket', JSON.stringify({ id: seeded.id, title: 'x' }))]),
      assistant('updated'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => true });
    expect(result.outcome).toMatchObject({ created: 0, updated: 1, declined: 0 });
  });

  it('does NOT count a failed mutation as accepted (isError → not created/updated)', async () => {
    const chat = new ScriptedChat([
      // create with no title → 400 isError; update a nonexistent id → 404 isError.
      assistant(null, [toolCall('c1', 'create_ticket', '{}')]),
      assistant(null, [toolCall('c2', 'update_ticket', '{"id":"tkt-missing","title":"x"}')]),
      assistant('nothing landed'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => true });
    expect(result.outcome).toMatchObject({ created: 0, updated: 0, declined: 0, noProposal: true });
  });

  it('reports outcome: declined when a mutation is rejected', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"Nope"}')]),
      assistant('skipped'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => false });
    expect(result.outcome).toMatchObject({ created: 0, declined: 1, noProposal: false });
  });

  it('reports outcome: noProposal when the model answers with no mutation', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '{"query":"x"}')]),
      assistant('nothing to do'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex() });
    expect(result.outcome).toMatchObject({ created: 0, updated: 0, declined: 0, noProposal: true });
  });

  it('accumulates outcome counts across multiple mutations', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"A"}'), toolCall('c2', 'create_ticket', '{"title":"B"}')]),
      assistant('made two'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => true });
    expect(result.outcome).toMatchObject({ created: 2, noProposal: false });
  });

  it('does not count read-only tools toward the outcome', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '{"query":"x"}'), toolCall('c2', 'create_ticket', '{"title":"C"}')]),
      assistant('done'),
    ]);
    const result = await runIntake('x', { chat, index: await buildIndex(), approve: () => true });
    expect(result.outcome).toMatchObject({ created: 1, updated: 0, declined: 0 });
  });
});
