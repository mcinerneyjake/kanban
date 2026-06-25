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
});
