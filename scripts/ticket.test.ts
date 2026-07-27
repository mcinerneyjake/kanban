import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTicketCli } from './ticket.js';
import { createTicket, getTicket } from '../server/tickets.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

const dirs = setupTempTicketDirs('kanban-ticket-cli');

async function seed(body = 'Original body.'): Promise<string> {
  const t = await createTicket({ title: 'Seed', type: 'task', priority: 'medium', status: 'backlog', body });
  return t.id;
}

describe('set', () => {
  it('applies a valid status and reports what persisted', async () => {
    const id = await seed();
    const out = await runTicketCli(['set', id, 'status', 'qa']);
    expect(out).toBe(`${id}  status -> qa`);
    expect((await getTicket(id)).status).toBe('qa');
  });

  it('applies the other enum fields and a free-form one', async () => {
    const id = await seed();
    await runTicketCli(['set', id, 'type', 'chore']);
    await runTicketCli(['set', id, 'priority', 'low']);
    await runTicketCli(['set', id, 'project', 'kanban']);
    const t = await getTicket(id);
    expect([t.type, t.priority, t.project]).toEqual(['chore', 'low', 'kanban']);
  });

  it('accepts a multi-word value', async () => {
    const id = await seed();
    const out = await runTicketCli(['set', id, 'project', 'portfolio', 'site']);
    expect(out).toBe(`${id}  project -> portfolio site`);
  });

  it('clears a nullable field with the literal "null"', async () => {
    const id = await seed();
    await runTicketCli(['set', id, 'project', 'kanban']);
    const out = await runTicketCli(['set', id, 'project', 'null']);
    expect(out).toBe(`${id}  project -> null`);
    expect((await getTicket(id)).project).toBeNull();
  });

  it('rejects an invalid enum value and leaves the ticket untouched', async () => {
    const id = await seed();
    await expect(runTicketCli(['set', id, 'status', 'shipped'])).rejects.toThrow(/invalid status "shipped"/);
    expect((await getTicket(id)).status).toBe('backlog');
  });

  it('rejects an unknown field', async () => {
    const id = await seed();
    await expect(runTicketCli(['set', id, 'title', 'Renamed'])).rejects.toThrow(/unknown field "title"/);
  });

  it('rejects a missing value', async () => {
    const id = await seed();
    await expect(runTicketCli(['set', id, 'status'])).rejects.toThrow(/needs a field and a value/);
  });
});

describe('append', () => {
  it('appends from a file without touching the existing body', async () => {
    const id = await seed('Original body.');
    const file = path.join(dirs.tickets, 'note.md');
    await fs.writeFile(file, '## Implementation summary\n\nDid the thing.\n', 'utf8');

    const out = await runTicketCli(['append', id, file]);
    const body = (await getTicket(id)).body;
    expect(body).toContain('Original body.');
    expect(body).toContain('## Implementation summary');
    expect(body.indexOf('Original body.')).toBeLessThan(body.indexOf('## Implementation'));
    expect(out).toMatch(/appended \d+ chars/);
  });

  it('appends from stdin', async () => {
    const id = await seed('Original body.');
    await runTicketCli(['append', id, '-'], 'From stdin.');
    expect((await getTicket(id)).body).toContain('From stdin.');
  });

  it('appends twice without losing the first append', async () => {
    const id = await seed('Original body.');
    await runTicketCli(['append', id, '-'], 'First.');
    await runTicketCli(['append', id, '-'], 'Second.');
    const body = (await getTicket(id)).body;
    expect(body).toContain('Original body.');
    expect(body).toContain('First.');
    expect(body).toContain('Second.');
  });

  it('rejects empty input rather than writing a blank append', async () => {
    const id = await seed('Original body.');
    await expect(runTicketCli(['append', id, '-'], '   \n  ')).rejects.toThrow(/nothing to append/);
    expect((await getTicket(id)).body.trim()).toBe('Original body.');
  });

  it('rejects a missing source', async () => {
    const id = await seed();
    await expect(runTicketCli(['append', id])).rejects.toThrow(/needs a file path/);
  });
});

describe('dispatch', () => {
  it('prints usage with no args or --help', async () => {
    expect(await runTicketCli([])).toMatch(/Usage:/);
    expect(await runTicketCli(['--help'])).toMatch(/Usage:/);
  });

  it('rejects an unknown command and a missing id', async () => {
    await expect(runTicketCli(['delete', 'tkt-1'])).rejects.toThrow(/unknown command "delete"/);
    await expect(runTicketCli(['set'])).rejects.toThrow(/missing ticket id/);
  });

  it('surfaces a 404 for an unknown ticket id', async () => {
    await expect(runTicketCli(['set', 'tkt-nope', 'status', 'qa'])).rejects.toThrow();
    await expect(runTicketCli(['append', 'tkt-nope', '-'], 'x')).rejects.toThrow();
  });

  // create/delete are deliberately absent: authoring goes through the metered local agent and
  // deletion stays a prompted MCP call (tkt-cccfc5a30f9c).
  it('offers no create or delete command', async () => {
    await expect(runTicketCli(['create', 'tkt-1'])).rejects.toThrow(/unknown command/);
  });
});
