import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TOOLS, dispatchTool } from './tools.js';
import { TicketIndex, type Embedder } from './retrieval.js';
import { TOOLS } from '../mcp/handlers.js';
import { createTicket, getTicket } from '../server/tickets.js';
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

// Validate + narrow a search_board result payload (no casts).
function parseResults(text: string): { id: string; title: string; score: number }[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('search_board did not return a JSON array');
  return parsed.map((p) => {
    if (typeof p !== 'object' || p === null) throw new Error('result is not an object');
    const id = 'id' in p ? p.id : undefined;
    const title = 'title' in p ? p.title : undefined;
    const score = 'score' in p ? p.score : undefined;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof score !== 'number') {
      throw new Error('result missing id/title/score');
    }
    return { id, title, score };
  });
}

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

  it('advertises exactly the five whitelisted tools', () => {
    expect(AGENT_TOOLS).toHaveLength(5);
    expect(names).toEqual(expect.arrayContaining(
      ['list_tickets', 'get_ticket', 'search_board', 'create_ticket', 'update_ticket'],
    ));
  });

  it('excludes destructive / dev-workflow tools', () => {
    expect(names).not.toContain('delete_ticket');
    expect(names).not.toContain('start_ticket');
  });

  it('uses the OpenAI function-tool shape for every tool', () => {
    for (const t of AGENT_TOOLS) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(t.function.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('carries the exact MCP description + inputSchema into parameters (lossless adapter)', () => {
    const mcpCreate = TOOLS.find((t) => t.name === 'create_ticket');
    const create = AGENT_TOOLS.find((t) => t.function.name === 'create_ticket');
    expect(create?.function.description).toBe(mcpCreate?.description);
    expect(create?.function.parameters).toEqual(mcpCreate?.inputSchema);
  });

  it('search_board requires a query', () => {
    const sb = AGENT_TOOLS.find((t) => t.function.name === 'search_board');
    expect(sb?.function.parameters).toMatchObject({ required: ['query'] });
  });
});

describe('dispatchTool — search_board', () => {
  it('routes to the index and returns structured, ordered results', async () => {
    const index = await TicketIndex.build(embedder, [mk('t1', 'Fix login bug'), mk('t2', 'Add dashboard')]);
    const res = await dispatchTool('search_board', { query: 'login screen broken' }, index);
    expect(res.isError).toBeFalsy();
    const results = parseResults(res.content[0].text);
    expect(results[0]).toMatchObject({ id: 't1', title: 'Fix login bug' });
    expect(typeof results[0].score).toBe('number');
  });

  it('respects the limit argument', async () => {
    const index = await TicketIndex.build(embedder, [mk('t1', 'Fix login bug'), mk('t2', 'login again'), mk('t3', 'Add dashboard')]);
    const res = await dispatchTool('search_board', { query: 'login', limit: 1 }, index);
    expect(parseResults(res.content[0].text)).toHaveLength(1);
  });

  it('errors without a query', async () => {
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('search_board', {}, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('query');
  });
});

describe('dispatchTool — MCP delegation', () => {
  it('delegates list_tickets to handleToolCall', async () => {
    await createTicket({ title: 'Seeded' });
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('list_tickets', undefined, index);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Seeded');
  });

  it('delegates create_ticket and persists the new ticket', async () => {
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'Made by agent' }, index);
    expect(res.isError).toBeFalsy();
    const list = await dispatchTool('list_tickets', undefined, index);
    expect(list.content[0].text).toContain('Made by agent');
  });

  it('propagates an MCP-layer error (unknown id)', async () => {
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('get_ticket', { id: 'tkt-doesnotexist' }, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});

describe('dispatchTool — security gate', () => {
  it('blocks delete_ticket and does NOT destroy the ticket', async () => {
    const created = await createTicket({ title: 'Keep me' });
    const index = await TicketIndex.build(embedder, []);
    const res = await dispatchTool('delete_ticket', { id: created.id }, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
    // the whitelist must PREVENT the deletion, not merely report it
    expect((await getTicket(created.id)).id).toBe(created.id);
  });

  it('blocks start_ticket', async () => {
    const index = await TicketIndex.build(embedder, []);
    expect((await dispatchTool('start_ticket', { id: 'x' }, index)).isError).toBe(true);
  });

  it('blocks an unknown tool', async () => {
    const index = await TicketIndex.build(embedder, []);
    expect((await dispatchTool('frobnicate', {}, index)).isError).toBe(true);
  });
});
