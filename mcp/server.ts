import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { listTickets, getTicket, createTicket, updateTicket, deleteTicket, HttpError } from '../server/tickets.js'
import type { Ticket } from '../shared/constants.js'

// Typed boundaries for each MCP tool's input — mirrors the JSON Schema declared
// in ListToolsRequestSchema so TypeScript and the runtime stay in sync.
interface TicketIdArgs { id: string }
interface UpdateTicketArgs extends TicketIdArgs, Partial<Pick<Ticket, 'title' | 'status' | 'priority' | 'type' | 'body'>> {}
type CreateTicketArgs = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body'>>

// Type predicates — narrow `args: unknown` at the MCP protocol boundary
// without type casting. The MCP SDK validates JSON Schema at runtime, so by
// the time these run the shape is already guaranteed; the predicates just
// surface that guarantee to TypeScript.
function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null
}

function hasStringId(args: unknown): args is TicketIdArgs {
  return isObject(args) && typeof args.id === 'string'
}

function isUpdateTicketArgs(args: unknown): args is UpdateTicketArgs {
  return isObject(args) && typeof args.id === 'string'
}

function isCreateTicketArgs(args: unknown): args is CreateTicketArgs {
  return isObject(args)
}

const server = new Server(
  { name: 'kanban', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

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
        properties: {
          id: { type: 'string', description: 'Ticket ID, e.g. tkt-abc123' },
        },
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
        },
        required: ['id'],
      },
    },
    {
      name: 'start_ticket',
      description: 'Mark a ticket in-progress and return its full details including body. Use this when the user picks a ticket to work on — it sets the status and loads everything needed to begin implementation in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Ticket ID' },
        },
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
        },
        required: ['title'],
      },
    },
    {
      name: 'delete_ticket',
      description: 'Permanently delete a ticket by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Ticket ID' },
        },
        required: ['id'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    let result: unknown
    switch (name) {
      case 'list_tickets':
        result = await listTickets()
        break
      case 'get_ticket': {
        if (!hasStringId(args)) throw new HttpError(400, 'Missing required field: id')
        result = await getTicket(args.id)
        break
      }
      case 'update_ticket': {
        if (!isUpdateTicketArgs(args)) throw new HttpError(400, 'Missing required field: id')
        const { id, ...patch } = args
        result = await updateTicket(id, patch)
        break
      }
      case 'start_ticket': {
        if (!hasStringId(args)) throw new HttpError(400, 'Missing required field: id')
        result = await updateTicket(args.id, { status: 'in-progress' })
        break
      }
      case 'create_ticket': {
        if (!isCreateTicketArgs(args)) throw new HttpError(400, 'Invalid arguments')
        result = await createTicket(args)
        break
      }
      case 'delete_ticket': {
        if (!hasStringId(args)) throw new HttpError(400, 'Missing required field: id')
        await deleteTicket(args.id)
        result = { deleted: args.id }
        break
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const message = err instanceof HttpError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`
    return { content: [{ type: 'text', text: message }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
