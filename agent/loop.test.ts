import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runIntake } from './loop.js';
import { type ChatClient, type ChatMessage, type ToolCall } from './llm.js';
import { type ChatTool } from './tools.js';
import { TicketIndex, type Embedder } from './retrieval.js';
import { listTickets } from '../server/tickets.js';
import { type Ticket } from '../shared/constants.js';

// Stub embedder: every text maps to the same vector — ranking is irrelevant
// here, the loop tests only care about dispatch/termination mechanics.
class StubEmbedder implements Embedder {
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map(() => [1, 0, 0])); }
  embedQuery(): Promise<number[]> { return Promise.resolve([1, 0, 0]); }
}
function mk(id: string, title: string): Ticket {
  return {
    id, title, body: '', type: 'task', priority: 'medium', status: 'backlog',
    order: 0, created: '', updated: '', project: null, blockers: [], parent: null, dueDate: null, assignee: null,
  };
}
const buildIndex = (): Promise<TicketIndex> => TicketIndex.build(new StubEmbedder(), [mk('t1', 'Existing login bug')]);

const assistant = (content: string | null, tool_calls?: ToolCall[]): ChatMessage => ({ role: 'assistant', content, tool_calls });
const toolCall = (id: string, name: string, args: string): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

// A ChatClient that replays a fixed script of assistant turns.
class ScriptedChat implements ChatClient {
  public calls = 0;
  public sawTools = false;
  constructor(private readonly turns: ChatMessage[]) {}
  complete(_messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> {
    if (tools.length > 0) this.sawTools = true;
    const turn = this.turns[this.calls] ?? assistant('(no more turns)');
    this.calls++;
    return Promise.resolve(turn);
  }
}

// handleToolCall (via create_ticket/list_tickets) touches the service — isolate it.
let tmpDir: string;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loop-test-'));
  process.env.TICKETS_DIR_OVERRIDE = tmpDir;
});
afterAll(async () => {
  delete process.env.TICKETS_DIR_OVERRIDE;
  await fs.rm(tmpDir, { recursive: true, force: true });
});
beforeEach(async () => {
  const files = await fs.readdir(tmpDir);
  await Promise.all(files.filter((f) => f.endsWith('.md')).map((f) => fs.unlink(path.join(tmpDir, f))));
});

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

  it('throws if the agent never stops calling tools', async () => {
    const chat: ChatClient = {
      complete: () => Promise.resolve(assistant(null, [toolCall('c', 'search_board', '{"query":"x"}')])),
    };
    await expect(runIntake('x', { chat, index: await buildIndex(), maxSteps: 3 }))
      .rejects.toThrow(/within 3 steps/);
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
});
