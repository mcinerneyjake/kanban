import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TicketConnector } from './ticket.js';
import { collectDocuments } from './connector.js';
import { createTicket } from '../../server/tickets.js';
import { type Ticket } from '../../shared/constants.js';

function mk(id: string, title: string, body = '', status: Ticket['status'] = 'backlog'): Ticket {
  return {
    id, title, body, type: 'task', priority: 'medium', status,
    order: 0, created: '', updated: '2026-01-01', project: null, blockers: [],
    parent: null, dueDate: null, assignee: null,
  };
}

describe('TicketConnector.toDocument', () => {
  const connector = new TicketConnector();

  it('tags every document with the connector source', () => {
    expect(connector.source).toBe('kanban');
    expect(connector.toDocument(mk('t1', 'Fix login')).source).toBe('kanban');
  });

  it('maps the ticket identity + updated stamp through', () => {
    const d = connector.toDocument(mk('t1', 'Fix login'));
    expect(d).toMatchObject({ id: 't1', title: 'Fix login', updated: '2026-01-01' });
  });

  it('carries ticket status through in meta (not as a core field)', () => {
    const d = connector.toDocument(mk('t1', 'Fix login', '', 'in-progress'));
    expect(d.meta).toEqual({ status: 'in-progress' });
  });

  it('embeds title + body into text, not just the title', () => {
    const d = connector.toDocument(mk('t1', 'Title', 'the login flow is broken'));
    expect(d.text).toContain('Title');
    expect(d.text).toContain('the login flow is broken');
  });

  it('trims text for a body-less ticket (no trailing blank lines)', () => {
    expect(connector.toDocument(mk('t1', 'Just a title')).text).toBe('Just a title');
  });
});

describe('TicketConnector.pull (live board)', () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ticket-connector-test-'));
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

  it('pulls the current board as raw tickets', async () => {
    await createTicket({ title: 'On the board' });
    const tickets = await new TicketConnector().pull();
    expect(tickets.map((t) => t.title)).toContain('On the board');
  });

  it('collectDocuments maps the whole board to kanban-sourced Documents', async () => {
    await createTicket({ title: 'First' });
    await createTicket({ title: 'Second' });
    const docs = await collectDocuments(new TicketConnector());
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.source === 'kanban')).toBe(true);
    expect(docs.map((d) => d.title).sort()).toEqual(['First', 'Second']);
  });
});
