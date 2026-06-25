import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proposeIntake } from './propose.js';
import { type ChatClient, type ChatMessage, type ToolCall } from './llm.js';
import { TicketIndex, type Embedder } from './retrieval.js';
import { listTickets } from '../server/tickets.js';
import { type Ticket } from '../shared/constants.js';

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

class ScriptedChat implements ChatClient {
  public calls = 0;
  constructor(private readonly turns: ChatMessage[]) {}
  complete(): Promise<ChatMessage> {
    const turn = this.turns[this.calls] ?? assistant('(no more turns)');
    this.calls++;
    return Promise.resolve(turn);
  }
}

// proposeIntake must never write — but its tools touch the service, so isolate it.
let tmpDir: string;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-propose-test-'));
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

describe('proposeIntake', () => {
  it('captures a create proposal WITHOUT writing it', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '{"query":"x"}')]),
      assistant(null, [toolCall('c2', 'create_ticket', '{"title":"New from agent"}')]),
      assistant('Proposed creating a ticket.'),
    ]);
    const result = await proposeIntake('add a thing', { chat, index: await buildIndex() });
    expect(result.proposal).toEqual({ action: 'create_ticket', args: { title: 'New from agent' } });
    expect(result.summary).toBe('Proposed creating a ticket.');
    expect((await listTickets()).some((t) => t.title === 'New from agent')).toBe(false);
  });

  it('captures an update proposal', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'update_ticket', '{"id":"t1","status":"done"}')]),
      assistant('Proposed an update.'),
    ]);
    const result = await proposeIntake('x', { chat, index: await buildIndex() });
    expect(result.proposal).toMatchObject({ action: 'update_ticket', args: { id: 't1', status: 'done' } });
  });

  it('returns a null proposal when the agent only searches', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'search_board', '{"query":"x"}')]),
      assistant('Nothing relevant; no action taken.'),
    ]);
    const result = await proposeIntake('x', { chat, index: await buildIndex() });
    expect(result.proposal).toBeNull();
    expect(result.summary).toContain('no action');
  });

  it('captures only the FIRST mutating proposal, and writes nothing', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', '{"title":"First"}')]),
      assistant(null, [toolCall('c2', 'create_ticket', '{"title":"Second"}')]),
      assistant('done'),
    ]);
    const result = await proposeIntake('x', { chat, index: await buildIndex() });
    expect(result.proposal).toMatchObject({ action: 'create_ticket', args: { title: 'First' } });
    const titles = (await listTickets()).map((t) => t.title);
    expect(titles).not.toContain('First');
    expect(titles).not.toContain('Second');
  });

  it('captures a proposal with empty args when the model sends malformed JSON', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'create_ticket', 'not json')]),
      assistant('done'),
    ]);
    const result = await proposeIntake('x', { chat, index: await buildIndex() });
    expect(result.proposal).toEqual({ action: 'create_ticket', args: {} });
  });
});
