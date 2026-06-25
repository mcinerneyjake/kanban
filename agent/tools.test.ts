import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TOOLS, dispatchTool } from './tools.js';
import { TicketIndex, type Embedder } from './retrieval.js';
import { createTicket } from '../server/tickets.js';
import { type Ticket } from '../shared/constants.js';

// Deterministic stub embedder (keyword -> fixed vector), as in retrieval.test.
class StubEmbedder implements Embedder {
  constructor(private readonly map: [string, number[]][]) {}
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map((t) => this.vec(t))); }
  embedQuery(text: string): Promise<number[]> { return Promise.resolve(this.vec(text)); }
  private vec(text: string): number[] {
    const hit = this.map.find(([k]) => text.toLowerCase().includes(k));
    return hit ? hit[1] : [0, 0, 1];
  }
}
function mk(id: string, title: string): Ticket {
  return {
    id, title, body: '', type: 'task', priority: 'medium', status: 'backlog',
    order: 0, created: '', updated: '', project: null, blockers: [], parent: null, dueDate: null, assignee: null,
  };
}
const embedder = new StubEmbedder([['login', [1, 0, 0]], ['dashboard', [0, 1, 0]]]);

// handleToolCall touches the service (real files) — redirect to a temp dir.
let tmpDir: string;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tools-test-'));
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

describe('AGENT_TOOLS', () => {
  const names = AGENT_TOOLS.map((t) => t.function.name);

  it('exposes the safe intake toolset', () => {
    expect(names).toEqual(expect.arrayContaining(
      ['list_tickets', 'get_ticket', 'search_board', 'create_ticket', 'update_ticket'],
    ));
  });

  it('excludes destructive / dev-workflow tools', () => {
    expect(names).not.toContain('delete_ticket');
    expect(names).not.toContain('start_ticket');
  });

  it('uses the OpenAI function-tool shape', () => {
    const create = AGENT_TOOLS.find((t) => t.function.name === 'create_ticket');
    expect(create?.type).toBe('function');
    expect(create?.function.parameters).toMatchObject({ type: 'object' });
  });
});

describe('dispatchTool', () => {
  it('routes search_board to the retrieval index', async () => {
    const index = await TicketIndex.build(embedder, [mk('t1', 'Fix login bug'), mk('t2', 'Add dashboard')]);
    const res = await dispatchTool('search_board', { query: 'login screen broken' }, index);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('t1');
  });

  it('rejects a non-whitelisted tool (delete_ticket)', async () => {
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('delete_ticket', { id: 'x' }, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
  });

  it('delegates a whitelisted MCP tool to handleToolCall', async () => {
    await createTicket({ title: 'Seeded' });
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('list_tickets', undefined, index);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Seeded');
  });

  it('errors on search_board without a query', async () => {
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('search_board', {}, index);
    expect(res.isError).toBe(true);
  });
});
