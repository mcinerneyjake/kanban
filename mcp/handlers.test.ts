import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleToolCall, TOOLS, CREATE_STATUS_ENUM, UPDATE_STATUS_ENUM } from './handlers.js';
import { createTicket, listTickets } from '../server/tickets.js';

// The handlers call the service layer, which writes real files — redirect that
// I/O to a temp dir so the real tickets/ folder is never touched.
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-mcp-test-'));
  process.env.TICKETS_DIR_OVERRIDE = tmpDir;
});

afterAll(async () => {
  delete process.env.TICKETS_DIR_OVERRIDE;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const files = await fs.readdir(tmpDir);
  await Promise.all(
    files.filter((f) => f.endsWith('.md')).map((f) => fs.unlink(path.join(tmpDir, f))),
  );
});

// ---------------------------------------------------------------------------
// Parsing helpers — narrow JSON.parse output with predicates, no casts.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Parse a successful tool result whose text payload is a JSON object.
function asRecord(result: { content: { text: string }[] }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.content[0].text);
  if (!isRecord(parsed)) throw new Error(`Expected JSON object, got: ${result.content[0].text}`);
  return parsed;
}

// Parse a successful tool result whose text payload is a JSON array of objects.
function asRecordArray(result: { content: { text: string }[] }): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(result.content[0].text);
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new Error(`Expected JSON object array, got: ${result.content[0].text}`);
  }
  return parsed;
}

// Read the advertised status enum off a tool's inputSchema without casts.
function statusEnumOf(toolName: string): string[] {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool || !isRecord(tool.inputSchema.properties)) return [];
  const status = tool.inputSchema.properties.status;
  if (!isRecord(status) || !Array.isArray(status.enum)) return [];
  return status.enum.filter((v): v is string => typeof v === 'string');
}

// Seed a ticket through the service layer (decoupled from the tool under test)
// and return its generated id.
async function seed(fields: Parameters<typeof createTicket>[0] = {}): Promise<string> {
  const t = await createTicket({ title: 'Seed', ...fields });
  return t.id;
}

// ---------------------------------------------------------------------------

describe('TOOLS schema', () => {
  it('exposes exactly the six kanban tools', () => {
    expect(new Set(TOOLS.map((t) => t.name))).toEqual(
      new Set(['list_tickets', 'get_ticket', 'update_ticket', 'start_ticket', 'create_ticket', 'delete_ticket']),
    );
  });

  // qa is a transition-only state: you update a ticket into it, you never create
  // one in it. The advertised create/update schemas must reflect that asymmetry.
  it('advertises qa on update_ticket but not on create_ticket', () => {
    expect(statusEnumOf('create_ticket')).not.toContain('qa');
    expect(statusEnumOf('update_ticket')).toContain('qa');
    expect(CREATE_STATUS_ENUM).not.toContain('qa');
    expect(UPDATE_STATUS_ENUM).toContain('qa');
  });
});

describe('list_tickets', () => {
  it('returns all tickets (happy path)', async () => {
    await seed({ title: 'A' });
    await seed({ title: 'B' });
    const tickets = asRecordArray(await handleToolCall('list_tickets', undefined));
    expect(tickets).toHaveLength(2);
  });

  it('returns an empty array when the board is empty (edge)', async () => {
    const tickets = asRecordArray(await handleToolCall('list_tickets', undefined));
    expect(tickets).toHaveLength(0);
  });
});

describe('get_ticket', () => {
  it('returns the ticket by id (happy path)', async () => {
    const id = await seed({ title: 'Find me' });
    const ticket = asRecord(await handleToolCall('get_ticket', { id }));
    expect(ticket.title).toBe('Find me');
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('get_ticket', { id: 'tkt-doesnotexist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('errors when id is missing (edge)', async () => {
    const res = await handleToolCall('get_ticket', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Missing required field: id');
  });
});

describe('create_ticket', () => {
  it('creates and persists a ticket, defaulting status to backlog (happy path)', async () => {
    const created = asRecord(await handleToolCall('create_ticket', { title: 'Brand new' }));
    expect(created.title).toBe('Brand new');
    expect(created.status).toBe('backlog');
    const all = await listTickets();
    expect(all.map((t) => t.id)).toContain(created.id);
  });

  it('honors explicit fields (edge)', async () => {
    const created = asRecord(await handleToolCall('create_ticket', {
      title: 'Configured', type: 'bug', priority: 'urgent', status: 'todo', project: 'Acme',
    }));
    expect(created.type).toBe('bug');
    expect(created.priority).toBe('urgent');
    expect(created.status).toBe('todo');
    expect(created.project).toBe('Acme');
  });

  it('persists dueDate and assignee (edge)', async () => {
    const created = asRecord(await handleToolCall('create_ticket', {
      title: 'Scheduled', dueDate: '2026-07-01', assignee: 'Jordan',
    }));
    expect(created.dueDate).toBe('2026-07-01');
    expect(created.assignee).toBe('Jordan');
  });

  it('errors when title is missing (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { type: 'task' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Title is required');
  });

  it('rejects an invalid enum value instead of dropping it (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { title: 'X', type: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid type');
  });

  it('rejects an invalid priority instead of dropping it (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { title: 'X', priority: 'meh' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid priority');
  });

  // qa is transition-only — create advertises no qa, so the runtime must reject it.
  it('rejects status qa at creation (rejection)', async () => {
    const res = await handleToolCall('create_ticket', { title: 'X', status: 'qa' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid status');
  });
});

describe('update_ticket', () => {
  it('transitions a ticket into qa (happy path)', async () => {
    const id = await seed();
    const updated = asRecord(await handleToolCall('update_ticket', { id, status: 'qa' }));
    expect(updated.status).toBe('qa');
    const reread = await listTickets();
    expect(reread.find((t) => t.id === id)?.status).toBe('qa');
  });

  it('clears the project when passed null (edge)', async () => {
    const id = await seed({ project: 'Acme' });
    const updated = asRecord(await handleToolCall('update_ticket', { id, project: null }));
    expect(updated.project).toBeNull();
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('update_ticket', { id: 'tkt-doesnotexist', status: 'done' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('rejects an invalid status instead of dropping it (rejection)', async () => {
    const id = await seed();
    const res = await handleToolCall('update_ticket', { id, status: 'inprogres' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid status');
    // the bad value must not have been persisted
    const reread = await listTickets();
    expect(reread.find((t) => t.id === id)?.status).toBe('backlog');
  });

  it('rejects an invalid type instead of dropping it (rejection)', async () => {
    const id = await seed();
    const res = await handleToolCall('update_ticket', { id, type: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid type');
  });

  it('rejects an invalid priority instead of dropping it (rejection)', async () => {
    const id = await seed();
    const res = await handleToolCall('update_ticket', { id, priority: 'wat' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid priority');
  });

  it('persists blockers, parent, and body fields (edge)', async () => {
    const parentId = await seed({ title: 'Parent' });
    const id = await seed();
    const updated = asRecord(await handleToolCall('update_ticket', {
      id, blockers: ['tkt-aaa', 'tkt-bbb'], parent: parentId, body: 'New body text',
    }));
    expect(updated.blockers).toEqual(['tkt-aaa', 'tkt-bbb']);
    expect(updated.parent).toBe(parentId);
    expect(updated.body).toBe('New body text');
    // ignores a non-string-array blockers value rather than persisting garbage
    const after = asRecord(await handleToolCall('update_ticket', { id, blockers: [1, 2] }));
    expect(after.blockers).toEqual(['tkt-aaa', 'tkt-bbb']);
  });

  it('clears the parent when passed null (edge)', async () => {
    const parentId = await seed({ title: 'Parent 2' });
    const id = await seed();
    await handleToolCall('update_ticket', { id, parent: parentId });
    const cleared = asRecord(await handleToolCall('update_ticket', { id, parent: null }));
    expect(cleared.parent).toBeNull();
  });

  it('sets and clears dueDate and assignee (edge)', async () => {
    const id = await seed();
    const set = asRecord(await handleToolCall('update_ticket', { id, dueDate: '2026-07-01', assignee: 'Jordan' }));
    expect(set.dueDate).toBe('2026-07-01');
    expect(set.assignee).toBe('Jordan');
    const cleared = asRecord(await handleToolCall('update_ticket', { id, dueDate: null, assignee: null }));
    expect(cleared.dueDate).toBeNull();
    expect(cleared.assignee).toBeNull();
  });
});

describe('start_ticket', () => {
  it('marks a backlog ticket in-progress (happy path)', async () => {
    const id = await seed({ status: 'backlog' });
    const started = asRecord(await handleToolCall('start_ticket', { id }));
    expect(started.status).toBe('in-progress');
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('start_ticket', { id: 'tkt-doesnotexist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});

describe('delete_ticket', () => {
  it('deletes the ticket (happy path)', async () => {
    const id = await seed();
    const res = asRecord(await handleToolCall('delete_ticket', { id }));
    expect(res.deleted).toBe(id);
    const all = await listTickets();
    expect(all.map((t) => t.id)).not.toContain(id);
  });

  it('errors on an unknown id (rejection)', async () => {
    const res = await handleToolCall('delete_ticket', { id: 'tkt-doesnotexist' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});

describe('unknown tool', () => {
  it('returns an isError result naming the tool', async () => {
    const res = await handleToolCall('frobnicate', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unknown tool: frobnicate');
  });
});
