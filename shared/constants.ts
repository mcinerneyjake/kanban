// Single source of truth for the domain enums, imported by BOTH the Express
// server (validation) and the React app (form options). Keeping them here
// avoids the classic drift where the UI offers a value the API rejects.

// The five columns rendered on the main board.
export const BOARD_STATUSES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'qa', label: 'QA' },
  { id: 'done', label: 'Done' },
] as const;

// All valid statuses — includes archived, used for API validation and the modal dropdown.
export const STATUSES = [
  ...BOARD_STATUSES,
  { id: 'archived', label: 'Archived' },
] as const;

export const STATUS_IDS = STATUSES.map((s) => s.id);

export const TYPES = ['bug', 'feature', 'task', 'chore'] as const;

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export type StatusId = (typeof STATUSES)[number]['id']
export type TicketType = (typeof TYPES)[number]
export type Priority = (typeof PRIORITIES)[number]

// Type predicates — use find() so TypeScript can narrow val to the literal
// union type without a cast. Safe to call with any string at runtime.
export function isStatusId(val: string): val is StatusId {
  return STATUS_IDS.find((s) => s === val) !== undefined;
}
export function isTicketType(val: string): val is TicketType {
  return TYPES.find((t) => t === val) !== undefined;
}
export function isPriority(val: string): val is Priority {
  return PRIORITIES.find((p) => p === val) !== undefined;
}

export type Ticket = {
  id: string
  title: string
  type: TicketType
  priority: Priority
  status: StatusId
  order: number
  created: string
  updated: string
  body: string
  project: string | null
  blockers: string[]
  parent: string | null
  dueDate: string | null
  assignee: string | null
}

// --- Dashboard aggregation -------------------------------------------------
// Shape returned by the /api/dashboard aggregation endpoint, shared so the
// server (producer) and the React client (consumer) can't drift. Counts exclude
// archived tickets; ordering follows the canonical enum order so the client can
// render without re-sorting.

export type StatusCount = { status: StatusId; count: number }
export type PriorityCount = { priority: Priority; count: number }
export type TypeCount = { type: TicketType; count: number }

// A trimmed ticket for the "recently updated" widget — just the fields the row
// needs, so the endpoint doesn't ship every ticket body.
export type RecentTicket = Pick<Ticket, 'id' | 'title' | 'status' | 'priority' | 'project' | 'updated'>

export type DashboardSummary = {
  project: string | null // null = all projects
  total: number
  byStatus: StatusCount[]
  byPriority: PriorityCount[]
  byType: TypeCount[]
  recentlyUpdated: RecentTicket[]
}
