import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  listTickets, getTicket, createTicket, updateTicket, deleteTicket, HttpError,
} from '../server/tickets.js';
import {
  isStatusId, isTicketType, isPriority,
  type Ticket,
} from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

// Return type carries the literal 'text' so callers don't need `as const`.
function textContent(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

// ---------------------------------------------------------------------------
// Arg converters: map Record<string, unknown> → concrete typed objects.
// Each function reads only the properties it cares about and validates their
// types via typeof / predicate — no casts at any point.
// ---------------------------------------------------------------------------

function extractId(args: Record<string, unknown> | undefined): string | null {
  return typeof args?.id === 'string' ? args.id : null;
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

type TicketFields = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent'>>

function extractTicketFields(args: Record<string, unknown> | undefined): TicketFields {
  const out: TicketFields = {};
  if (!args) return out;
  if (typeof args.title === 'string') out.title = args.title;
  if (typeof args.type === 'string' && isTicketType(args.type)) out.type = args.type;
  if (typeof args.priority === 'string' && isPriority(args.priority)) out.priority = args.priority;
  if (typeof args.status === 'string' && isStatusId(args.status)) out.status = args.status;
  if (typeof args.body === 'string') out.body = args.body;
  if (typeof args.project === 'string') out.project = args.project;
  else if (args.project === null) out.project = null;
  if (isStringArray(args.blockers)) out.blockers = args.blockers;
  if (typeof args.parent === 'string') out.parent = args.parent;
  else if (args.parent === null) out.parent = null;
  return out;
}

// ---------------------------------------------------------------------------
// Server definition
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'kanban', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_tickets',
      description: 'List all kanban tickets with their id, title, status, priority, type, and description. Use this first to find a ticket by title before working on it.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_ticket',
      description: 'Get full details of a specific ticket by ID, including its markdown body.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ticket ID, e.g. tkt-abc123' } },
        required: ['id'],
      },
    },
    {
      name: 'update_ticket',
      description: 'Update one or more fields on a ticket. Omit fields you do not want to change.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Ticket ID' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['backlog', 'todo', 'in-progress', 'qa', 'done'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          type: { type: 'string', enum: ['bug', 'feature', 'task', 'chore'] },
          body: { type: 'string', description: 'Full markdown description of the ticket' },
          project: { type: ['string', 'null'], description: 'Project name, or null to clear' },
          blockers: { type: 'array', items: { type: 'string' }, description: 'List of blocking ticket IDs' },
          parent: { type: ['string', 'null'], description: 'Parent ticket ID, or null to clear' },
        },
        required: ['id'],
      },
    },
    {
      name: 'start_ticket',
      description: 'Mark a ticket in-progress and return its full details including body. Use this when the user picks a ticket to work on — it sets the status and loads everything needed to begin implementation in one call.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ticket ID' } },
        required: ['id'],
      },
    },
    {
      name: 'create_ticket',
      description: 'Create a new ticket on the kanban board.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          type: { type: 'string', enum: ['bug', 'feature', 'task', 'chore'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          status: { type: 'string', enum: ['backlog', 'todo', 'in-progress', 'done'] },
          body: { type: 'string', description: 'Markdown description' },
          project: { type: 'string', description: 'Project name' },
          blockers: { type: 'array', items: { type: 'string' }, description: 'List of blocking ticket IDs' },
          parent: { type: 'string', description: 'Parent ticket ID' },
        },
        required: ['title'],
      },
    },
    {
      name: 'delete_ticket',
      description: 'Permanently delete a ticket by ID.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Ticket ID' } },
        required: ['id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_tickets':
        return { content: [textContent(JSON.stringify(await listTickets(), null, 2))] };

      case 'get_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await getTicket(id), null, 2))] };
      }

      case 'update_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await updateTicket(id, extractTicketFields(args)), null, 2))] };
      }

      case 'start_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await updateTicket(id, { status: 'in-progress' }), null, 2))] };
      }

      case 'create_ticket':
        return { content: [textContent(JSON.stringify(await createTicket(extractTicketFields(args)), null, 2))] };

      case 'delete_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        await deleteTicket(id);
        return { content: [textContent(JSON.stringify({ deleted: id }, null, 2))] };
      }

      default:
        return { content: [textContent(`Unknown tool: ${name}`)], isError: true };
    }
  } catch (err) {
    const message = err instanceof HttpError
      ? err.message
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [textContent(message)], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
