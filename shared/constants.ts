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
] as const

// All valid statuses — includes archived, used for API validation and the modal dropdown.
export const STATUSES = [
  ...BOARD_STATUSES,
  { id: 'archived', label: 'Archived' },
] as const

export const STATUS_IDS = STATUSES.map((s) => s.id)

export const TYPES = ['bug', 'feature', 'task', 'chore'] as const

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

export type StatusId = (typeof STATUSES)[number]['id']
export type TicketType = (typeof TYPES)[number]
export type Priority = (typeof PRIORITIES)[number]

// Type predicates — use find() so TypeScript can narrow val to the literal
// union type without a cast. Safe to call with any string at runtime.
export function isStatusId(val: string): val is StatusId {
  return STATUS_IDS.find((s) => s === val) !== undefined
}
export function isTicketType(val: string): val is TicketType {
  return TYPES.find((t) => t === val) !== undefined
}
export function isPriority(val: string): val is Priority {
  return PRIORITIES.find((p) => p === val) !== undefined
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
}
