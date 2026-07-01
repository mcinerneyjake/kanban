import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  listTickets, getTicket, createTicket, updateTicket, deleteTicket, HttpError,
} from '../server/tickets.js';
import { appendEvent, getTicketEvents } from '../server/events.js';
import {
  BOARD_STATUSES, STATUS_IDS, isStatusId, isTicketType, isPriority,
  type Ticket, type StatusId,
} from '../shared/constants.js';

// ---------------------------------------------------------------------------
// MCP tool handlers — the testable core of the kanban MCP server. mcp/server.ts
// is a thin entrypoint that wires these into a stdio transport; everything with
// logic lives here so it can be unit-tested without connecting a transport.
// ---------------------------------------------------------------------------

// Result shape returned to the MCP runtime. Text-only content keeps callers
// from needing `as const` on the literal 'text' tag.
export type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

// Advertised status enums for the create/update tool schemas. Deliberately
// asymmetric: a ticket is CREATED in a pre-work state and only TRANSITIONS into
// `qa` via update — `qa` is a review gate you move a ticket into, never one you
// create a ticket in. Derived from the single source of truth (BOARD_STATUSES)
// so the advertised contract can never drift from the real column set.
export const UPDATE_STATUS_ENUM = BOARD_STATUSES.map((s) => s.id);
export const CREATE_STATUS_ENUM = UPDATE_STATUS_ENUM.filter((s) => s !== 'qa');

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

function textContent(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

// ---------------------------------------------------------------------------
// Arg converters: map Record<string, unknown> → concrete typed objects. Each
// reads only the properties it cares about and validates their types via typeof
// / predicate — no casts at any point.
// ---------------------------------------------------------------------------

function extractId(args: Record<string, unknown> | undefined): string | null {
  return typeof args?.id === 'string' ? args.id : null;
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

// Validate a status string against the per-call allowed set, returning the
// narrowed StatusId. Shared by the create/update field extractor and the
// list_tickets status filter so the two validation paths can't drift.
function validatedStatus(value: string, allowedStatuses: readonly string[]): StatusId {
  if (!isStatusId(value) || !allowedStatuses.includes(value)) {
    throw new HttpError(400, `Invalid status: ${value} (allowed: ${allowedStatuses.join(', ')})`);
  }
  return value;
}

type TicketFields = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>>

// `allowedStatuses` is the per-operation status set (create vs update) — passed
// in so the converter enforces the *advertised* schema at runtime, not just in
// the JSON schema. An invalid enum value is rejected (matching the HTTP route's
// `validateEnums` 400) rather than silently dropped, so a caller's typo or an
// impossible state (e.g. status `qa` at create) surfaces as an error instead of
// a no-op. Enum membership reuses the shared predicates — one source of truth.
function extractTicketFields(
  args: Record<string, unknown> | undefined,
  allowedStatuses: readonly string[],
): TicketFields {
  const out: TicketFields = {};
  if (!args) return out;
  if (typeof args.title === 'string') out.title = args.title;
  if (typeof args.type === 'string') {
    if (!isTicketType(args.type)) throw new HttpError(400, `Invalid type: ${args.type}`);
    out.type = args.type;
  }
  if (typeof args.priority === 'string') {
    if (!isPriority(args.priority)) throw new HttpError(400, `Invalid priority: ${args.priority}`);
    out.priority = args.priority;
  }
  if (typeof args.status === 'string') out.status = validatedStatus(args.status, allowedStatuses);
  if (typeof args.body === 'string') out.body = args.body;
  if (typeof args.project === 'string') out.project = args.project;
  else if (args.project === null) out.project = null;
  if (isStringArray(args.blockers)) out.blockers = args.blockers;
  if (typeof args.parent === 'string') out.parent = args.parent;
  else if (args.parent === null) out.parent = null;
  if (typeof args.dueDate === 'string') out.dueDate = args.dueDate;
  else if (args.dueDate === null) out.dueDate = null;
  if (typeof args.assignee === 'string') out.assignee = args.assignee;
  else if (args.assignee === null) out.assignee = null;
  return out;
}

// ---------------------------------------------------------------------------
// list_tickets projection + filtering. The list view returns a LIGHTWEIGHT
// summary of every ticket — never the full markdown body, which can be many KB
// each (long `## Implementation summary` blocks) and belongs to get_ticket.
// This keeps the result well under the MCP tool-result token limit and matches
// the tool's advertised contract. The service layer (listTickets) is left
// returning full Ticket[] so the agent's retrieval/embedding path is untouched.
// ---------------------------------------------------------------------------

type TicketSummary = Pick<Ticket, 'id' | 'title' | 'status' | 'priority' | 'type' | 'project'> & {
  summary: string
}

const SUMMARY_MAX = 100;

// One-glance gist: the first non-empty body line, with only *proper* leading
// markdown markers stripped — a heading (`#`..`######`) or list/quote marker
// (`-`/`*`/`>`) that is followed by whitespace. Content like "#1 priority" or
// "-5C offset" is preserved (no following space → not a marker). Capped at
// SUMMARY_MAX, counting by code point (Array.from) so the cut never splits a
// surrogate pair. Loops and returns early — no full-body transform.
function summarize(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^(?:#{1,6}\s+|[-*>]\s+)+/, '').trim();
    if (line.length === 0) continue;
    const chars = Array.from(line);
    return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : line;
  }
  return '';
}

function toSummary(t: Ticket): TicketSummary {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    type: t.type,
    project: t.project,
    summary: summarize(t.body),
  };
}

type ListFilters = { status: StatusId | null; project: string | null; query: string | null }

// Trim a string filter arg; a non-string or blank value → null (no filter),
// matching the trim convention of the HTTP /api/tickets route.
function normalizeFilter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// The status filter is validated against ALL valid statuses (STATUS_IDS,
// including `archived` so archived tickets can be listed) — matching the tool's
// advertised enum. A present-but-invalid status (wrong type, or outside the
// enum) is REJECTED rather than coerced to "no filter", so a malformed scope
// can never silently return the whole board.
function extractListFilters(args: Record<string, unknown> | undefined): ListFilters {
  let status: StatusId | null = null;
  if (args?.status !== undefined && args.status !== null) {
    if (typeof args.status !== 'string') {
      throw new HttpError(400, `Invalid status: ${String(args.status)} (allowed: ${STATUS_IDS.join(', ')})`);
    }
    status = validatedStatus(args.status, STATUS_IDS);
  }
  return { status, project: normalizeFilter(args?.project), query: normalizeFilter(args?.query) };
}

// AND-combine the optional filters. query is a case-insensitive title substring.
function applyListFilters(tickets: Ticket[], f: ListFilters): Ticket[] {
  const q = f.query?.toLowerCase();
  return tickets.filter((t) =>
    (f.status === null || t.status === f.status) &&
    (f.project === null || t.project === f.project) &&
    (q === undefined || t.title.toLowerCase().includes(q)),
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: 'list_tickets',
    description: 'List kanban tickets as a lightweight summary — id, title, status, priority, type, project, and a one-line summary of each body (NOT the full body; call get_ticket for that). Optionally filter by status, project, or a case-insensitive title substring (query). Use this first to find a ticket before working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUS_IDS, description: 'Only return tickets with this status (includes archived)' },
        project: { type: 'string', description: 'Only return tickets in this project' },
        query: { type: 'string', description: 'Case-insensitive substring match on the ticket title' },
      },
      required: [],
    },
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
        status: { type: 'string', enum: UPDATE_STATUS_ENUM },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        type: { type: 'string', enum: ['bug', 'feature', 'task', 'chore'] },
        body: { type: 'string', description: 'Full markdown description of the ticket' },
        project: { type: ['string', 'null'], description: 'Project name, or null to clear' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'List of blocking ticket IDs' },
        parent: { type: ['string', 'null'], description: 'Parent ticket ID, or null to clear' },
        dueDate: { type: ['string', 'null'], description: 'Due date YYYY-MM-DD, or null to clear' },
        assignee: { type: ['string', 'null'], description: 'Assignee name, or null to clear' },
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
        status: { type: 'string', enum: CREATE_STATUS_ENUM },
        body: { type: 'string', description: 'Markdown description' },
        project: { type: 'string', description: 'Project name' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'List of blocking ticket IDs' },
        parent: { type: 'string', description: 'Parent ticket ID' },
        dueDate: { type: 'string', description: 'Due date YYYY-MM-DD' },
        assignee: { type: 'string', description: 'Assignee name' },
      },
      required: ['title'],
    },
  },
  {
    name: 'record_review',
    description: 'Record the manual review milestone (the "Ready to commit?" gate) for a ticket — marks its Review step complete in the tracker. The commit hook records this automatically on a successful commit; use this tool to mark it explicitly (e.g. when the user confirms their review before you commit).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Ticket ID' } },
      required: ['id'],
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
];

// ---------------------------------------------------------------------------
// Dispatch: one tool call → one ToolResult. Errors are normalized to an
// isError result carrying the message (HttpError messages pass through; any
// other throw is wrapped) so the MCP client always gets structured content.
// ---------------------------------------------------------------------------

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_tickets': {
        const filters = extractListFilters(args); // throws on a present-but-invalid status
        const summaries = applyListFilters(await listTickets(), filters).map(toSummary);
        // Compact (no indent): this is a potentially large array, and the extra
        // whitespace from pretty-printing is pure token cost for an LLM reader.
        // Single-object results (get_ticket etc.) stay pretty-printed below.
        return { content: [textContent(JSON.stringify(summaries))] };
      }

      case 'get_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await getTicket(id), null, 2))] };
      }

      case 'update_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await updateTicket(id, extractTicketFields(args, UPDATE_STATUS_ENUM)), null, 2))] };
      }

      case 'start_ticket': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        return { content: [textContent(JSON.stringify(await updateTicket(id, { status: 'in-progress' }), null, 2))] };
      }

      case 'record_review': {
        const id = extractId(args);
        if (!id) throw new HttpError(400, 'Missing required field: id');
        // Writes the events file directly via the service layer — no HTTP, so
        // it works whether or not the web server is running.
        await appendEvent({ ticketId: id, step: 'review', state: 'reached' });
        return { content: [textContent(JSON.stringify(await getTicketEvents(id), null, 2))] };
      }

      case 'create_ticket':
        return { content: [textContent(JSON.stringify(await createTicket(extractTicketFields(args, CREATE_STATUS_ENUM)), null, 2))] };

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
}
