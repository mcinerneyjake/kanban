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

// Statuses a ticket may be CREATED in: the board columns minus `qa`. `qa` is a
// review gate you transition a ticket INTO (via update), never one you create a
// ticket in; `archived` is a lifecycle end-state (not a board column), so it's
// excluded too. Shared so the HTTP service (createTicket) and the MCP create
// schema enforce the same restriction instead of diverging. Typed as
// readonly StatusId[] so `.includes(status)` accepts any StatusId.
export const CREATE_STATUS_IDS: readonly StatusId[] = BOARD_STATUSES
  .map((s) => s.id)
  .filter((s) => s !== 'qa');

export const TYPES = ['bug', 'feature', 'task', 'chore'] as const;

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

// Provenance: who authored a ticket. Only `agent` is ever stamped — a manual
// (human/CLI/HTTP) write leaves `source` null. Distinct from Document.source
// (which names a retrieval connector); this names the WRITER of the record.
export const SOURCES = ['agent'] as const;

// Trusted provenance stamp, threaded only through the agent write path (never
// from HTTP bodies or model tool args) so authorship can't be spoofed.
export type Provenance = { source: TicketSource; runId: string }

export type StatusId = (typeof STATUSES)[number]['id']
export type TicketType = (typeof TYPES)[number]
export type Priority = (typeof PRIORITIES)[number]
export type TicketSource = (typeof SOURCES)[number]

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
export function isSource(val: string): val is TicketSource {
  return SOURCES.find((s) => s === val) !== undefined;
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
  // Provenance — present (non-null) only for agent-authored tickets (see
  // SOURCES). Optional so the many ticket literals in tests need not set them;
  // normalize() always emits an explicit value (null for human/CLI writes).
  // `runId` links to the run log (agent/runLog.ts) for per-ticket usage lookup.
  source?: TicketSource | null
  runId?: string | null
}

// --- Dashboard aggregation -------------------------------------------------
// Shape returned by the /api/dashboard aggregation endpoint, shared so the
// server (producer) and the React client (consumer) can't drift. Counts exclude
// archived tickets; ordering follows the canonical enum order so the client can
// render without re-sorting.

export type StatusCount = { status: StatusId; count: number }
export type PriorityCount = { priority: Priority; count: number }
export type TypeCount = { type: TicketType; count: number }

// --- Workflow-step telemetry ----------------------------------------------
// The canonical "package tracking" pipeline: the ordered milestones a ticket
// passes through while Claude works it. Rendered in full (future UI) with each
// node lit up as events arrive. Shared so the emitters (service + hook) and the
// reader/UI can't drift. See tkt-512f9b15ddb8.
//
// Detectability split: `started`/`qa`/`done` are STATUS transitions, emitted
// server-side by updateTicket; the rest are shell commands, emitted by the
// PostToolUse hook. Implementation itself has no scan event — it's the
// UI-derived gap between `branch` and the first gate.

export const STEPS = [
  { id: 'started', label: 'Started' },
  { id: 'branch', label: 'Branch' },
  { id: 'typecheck', label: 'Typecheck' },
  { id: 'lint', label: 'Lint' },
  { id: 'test', label: 'Tests' },
  { id: 'review', label: 'Review' },
  { id: 'commit', label: 'Commit' },
  { id: 'pr_opened', label: 'PR opened' },
  { id: 'qa', label: 'QA' },
  { id: 'done', label: 'Done' },
] as const;

export const STEP_IDS = STEPS.map((s) => s.id);
export type StepId = (typeof STEPS)[number]['id']

// `reached` = a status milestone was hit (no pass/fail semantics); `passed` /
// `failed` = a command milestone resolved via its exit code.
export const STEP_STATES = ['reached', 'passed', 'failed'] as const;
export type StepState = (typeof STEP_STATES)[number]

// Status transitions that map to a tracked milestone. Other statuses
// (backlog/todo/archived) emit nothing.
export const STATUS_STEP: Partial<Record<StatusId, StepId>> = {
  'in-progress': 'started',
  qa: 'qa',
  done: 'done',
};

// One append-only telemetry record.
export type TicketEvent = {
  ticketId: string
  step: StepId
  state: StepState
  at: string
  detail?: string
}

// A reduced pipeline node for the tracking view: the latest state per step, or
// `pending` when no event has arrived for it yet.
export type PipelineStep = {
  step: StepId
  label: string
  state: StepState | 'pending'
  at: string | null
}

export function isStepId(val: string): val is StepId {
  return STEP_IDS.find((s) => s === val) !== undefined;
}
export function isStepState(val: string): val is StepState {
  return STEP_STATES.find((s) => s === val) !== undefined;
}

// The `GET /api/tickets/:id/events` payload. Shared so the server (producer)
// and the React client (consumer) can't drift.
export type TicketEventsResponse = {
  ticketId: string
  pipeline: PipelineStep[]
  events: TicketEvent[]
}

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

// --- Agent economics (run-log aggregation) ---------------------------------
// Response shape for GET /api/economics — a FinOps rollup over the agent run
// log (agent/cost/runLog.ts). Shared so the server aggregator and the React
// view can't drift. Mirrors the persisted CostLine, but re-declared here (not
// imported from agent/cost) so shared/ stays a dependency-free leaf.

export type EconomicsLineKind = 'measured' | 'assumed' | 'externality'

// One aggregated economic figure. `amount: null` = notional (a required input
// was unset) — never a silent zero, same contract as the per-run CostLine.
export type EconomicsLine = {
  label: string
  amount: number | null
  unit: string
  kind: EconomicsLineKind
  note?: string
}

// One day's rollup for the time-series chart.
export type EconomicsPoint = {
  date: string // YYYY-MM-DD
  runCostUsd: number | null
  totalTokens: number
  acceptedTickets: number
}

export type EconomicsTotals = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  activeMs: number
  created: number
  updated: number
  declined: number
  acceptedTickets: number // created + updated
}

export type EconomicsSummary = {
  range: { from: string | null; to: string | null } // null = unbounded
  runs: number
  totals: EconomicsTotals
  // Cost lines summed across the range, grouped as the per-run RunSummary is.
  measured: EconomicsLine[]
  assumed: EconomicsLine[]
  externalities: EconomicsLine[]
  headline: EconomicsLine[] // cost per accepted ticket · net savings · local vs cloud
  timeSeries: EconomicsPoint[]
  // True if any summed USD line had a notional (null) amount — keeps the
  // aggregated $ totals honest rather than silently under-reporting.
  partial: boolean
}
