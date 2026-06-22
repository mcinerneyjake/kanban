// Single source of truth for the domain enums, imported by BOTH the Express
// server (validation) and the React app (form options). Keeping them here
// avoids the classic drift where the UI offers a value the API rejects.

export const STATUSES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'done', label: 'Done' },
] as const

export const STATUS_IDS = STATUSES.map((s) => s.id)

export const TYPES = ['bug', 'feature', 'task', 'chore'] as const

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

export type StatusId = (typeof STATUSES)[number]['id']
export type TicketType = (typeof TYPES)[number]
export type Priority = (typeof PRIORITIES)[number]

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
}
