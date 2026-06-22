import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { listTickets, getTicket, createTicket, updateTicket, deleteTicket, HttpError } from '../server/tickets.js'

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
      case 'get_ticket':
        result = await getTicket((args as { id: string }).id)
        break
      case 'update_ticket': {
        const { id, ...patch } = args as { id: string } & Record<string, unknown>
        result = await updateTicket(id, patch)
        break
      }
      case 'start_ticket': {
        const id = (args as { id: string }).id
        result = await updateTicket(id, { status: 'in-progress' })
        break
      }
      case 'create_ticket':
        result = await createTicket(args as Record<string, unknown>)
        break
      case 'delete_ticket':
        await deleteTicket((args as { id: string }).id)
        result = { deleted: (args as { id: string }).id }
        break
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const message = err instanceof HttpError ? err.message : `Unexpected error: ${(err as Error).message}`
    return { content: [{ type: 'text', text: message }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
