import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proposeIntake } from './propose.js';
import { type ChatClient, type ChatMessage, type ToolCall } from './llm.js';
import { DocumentIndex, type Embedder } from '../retrieval/retrieval.js';
import { listTickets } from '../../server/tickets.js';

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
  // Status-changing ops emit telemetry; keep it out of the real events/ dir.
  process.env.EVENTS_DIR_OVERRIDE = tmpDir;
});
afterAll(async () => {
  delete process.env.TICKETS_DIR_OVERRIDE;
  delete process.env.EVENTS_DIR_OVERRIDE;
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
    // Summary is synthesized from the proposal (the loop halts at capture, so the
    // model's own summary turn is never reached) — see the narration-bug fix below.
    expect(result.summary).toBe('Proposed a new ticket "New from agent" for your review.');
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

  // tkt-2107252ff0fb: the loop must HALT at the first captured mutation so the model
  // never observes a decline (which it narrated as a failure) and can't be tempted
  // into a corrective duplicate-create. The summary is synthesized, not the model's.
  it('halts at the first captured mutation — non-failure summary, no post-capture turn', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'update_ticket', '{"id":"t1","status":"done"}')]),
      // The old code fed the decline back and let the model keep going — it would
      // reach these turns and either narrate a failure or attempt a corrective
      // duplicate-create. The halt must make both unreachable.
      assistant(null, [toolCall('c2', 'create_ticket', '{"title":"Corrective dup"}')]),
      assistant('No changes were made because the update was declined.'),
    ]);
    const result = await proposeIntake('login broken again', { chat, index: await buildIndex() });
    expect(result.proposal).toMatchObject({ action: 'update_ticket', args: { id: 't1', status: 'done' } });
    // The captured proposal drives the summary — NOT the model's failure narration.
    expect(result.summary).toContain('Proposed an update to t1');
    expect(result.summary).not.toMatch(/declined|no changes were made/i);
    // The loop stopped at the first mutation: the corrective-create + failure-summary
    // turns were never consumed, and nothing was written.
    expect(chat.calls).toBe(1);
    expect((await listTickets()).length).toBe(0);
  });

  it('names the changed fields in an update proposal summary', async () => {
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'update_ticket', '{"id":"t1","priority":"high"}')]),
    ]);
    const result = await proposeIntake('bump it', { chat, index: await buildIndex() });
    expect(result.summary).toBe('Proposed an update to t1 (priority) for your review.');
  });

  it('ignores a non-create/update gated call and captures the real create/update (tkt-fa3b427fb0b6)', async () => {
    // A prompt-injected `delete_ticket` (or any non-mutation gated tool) must not
    // become the proposal — only create/update do, and the legitimate one that
    // follows is captured instead of being displaced.
    const chat = new ScriptedChat([
      assistant(null, [toolCall('c1', 'delete_ticket', '{"id":"t1"}')]),
      assistant(null, [toolCall('c2', 'update_ticket', '{"id":"t1","status":"done"}')]),
      assistant('Proposed an update.'),
    ]);
    const result = await proposeIntake('x', { chat, index: await buildIndex() });
    expect(result.proposal).toMatchObject({ action: 'update_ticket', args: { id: 't1', status: 'done' } });
    // and nothing was written
    expect((await listTickets()).length).toBe(0);
  });
});
