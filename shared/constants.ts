// Single source of truth for domain enums (server validation + React form options) — prevents UI/API drift.

export const BOARD_STATUSES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'qa', label: 'QA' },
  { id: 'done', label: 'Done' },
] as const;

// All statuses incl. archived (API validation + modal dropdown).
export const STATUSES = [
  ...BOARD_STATUSES,
  { id: 'archived', label: 'Archived' },
] as const;

export const STATUS_IDS = STATUSES.map((s) => s.id);

// Statuses a ticket may be CREATED in: board columns minus qa (a gate you
// transition INTO) and archived (an end-state). Shared so the HTTP service and
// MCP create schema can't diverge.
export const CREATE_STATUS_IDS: readonly StatusId[] = BOARD_STATUSES
  .map((s) => s.id)
  .filter((s) => s !== 'qa');

export const TYPES = ['bug', 'feature', 'task', 'chore'] as const;

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

// Provenance authorship: agent = autonomous CLI write; assisted = human-reviewed
// agent draft. Human/MCP/HTTP write leaves source null. Distinct from
// Document.source (a retrieval connector); this names the WRITER.
export const SOURCES = ['agent', 'assisted'] as const;

// Trusted provenance stamp — threaded only through the agent write path, never
// from HTTP bodies or tool args, so authorship can't be spoofed.
export type Provenance = { source: TicketSource; runId: string }

export type StatusId = (typeof STATUSES)[number]['id']
export type TicketType = (typeof TYPES)[number]
export type Priority = (typeof PRIORITIES)[number]
export type TicketSource = (typeof SOURCES)[number]

// Embedded-terminal WS close code (server → client signal), in the WS application range 3000–4999.
// 4500 = the container/session failed to START (docker down, image missing, dtach never ready). The
// WS handshake completes before `docker run` fails, so a bare-close 1005 can't be told from a clean
// session end — this distinct code lets the client KEEP the widget and surface the failure instead of
// silently self-dismissing (tkt-171759eb29f6). A clean end stays a bare close (browser reports 1005).
// Shared so the server emitter and the client classifier can't drift on the number.
export const TERMINAL_STARTUP_FAILURE_CODE = 4500;

// 4501 = a REATTACH failed — the session existed but the server couldn't rejoin it (the adopted
// container isn't ready after the grace window, a transient exec-spawn failure, or the entry was
// disposed mid-reattach). Like 4500 the client keeps the widget and shows an error rather than
// dismissing (the session didn't cleanly end — it became unreachable). Distinct from 4500 for
// diagnosis: 4500 = never started, 4501 = couldn't be rejoined (tkt-42a6d95a92d1).
export const TERMINAL_REATTACH_FAILED_CODE = 4501;

// Type predicates — find() narrows to the literal union without a cast.
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
  // Provenance — non-null only for agent-authored tickets. Optional so test
  // literals can omit it; normalize() always emits an explicit value. runId links
  // to the run log for per-ticket usage lookup.
  source?: TicketSource | null
  runId?: string | null
}

// --- Dashboard aggregation -------------------------------------------------
// Shared server/client so they can't drift; counts exclude archived, canonical enum order.

export type StatusCount = { status: StatusId; count: number }
export type PriorityCount = { priority: Priority; count: number }
export type TypeCount = { type: TicketType; count: number }

// --- Workflow-step telemetry ----------------------------------------------
// Ordered milestones a ticket passes through. Shared so emitters + reader can't drift (tkt-512f9b15ddb8).
// Split: started/qa/done are STATUS transitions (updateTicket); the rest are shell commands (PostToolUse hook).

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

// reached = status milestone hit (no pass/fail); passed/failed = command milestone resolved via exit code.
export const STEP_STATES = ['reached', 'passed', 'failed'] as const;
export type StepState = (typeof STEP_STATES)[number]

// Status transitions that map to a tracked milestone; others emit nothing.
export const STATUS_STEP: Partial<Record<StatusId, StepId>> = {
  'in-progress': 'started',
  qa: 'qa',
  done: 'done',
};

export type TicketEvent = {
  ticketId: string
  step: StepId
  state: StepState
  at: string
  detail?: string
}

// A reduced pipeline node: latest state per step, or pending if none arrived.
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

// GET /api/tickets/:id/events payload. Shared server/client to prevent drift.
export type TicketEventsResponse = {
  ticketId: string
  pipeline: PipelineStep[]
  events: TicketEvent[]
}

// Trimmed ticket for the "recently updated" widget — avoids shipping every body.
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
// GET /api/economics rollup. Shared server/client. Re-declared here (not imported
// from agent/cost) so shared/ stays a dependency-free leaf.

// Canonical economics-line labels in shared/ so a rename is a compile error across
// every consumer, not a silent find() miss.
export const LABEL_TOTAL_RUN_COST = 'total run cost';
export const LABEL_COST_PER_ACCEPTED = 'cost per accepted ticket';
export const LABEL_NET_SAVINGS = 'net savings';
export const LABEL_LOCAL_VS_CLOUD = 'local vs cloud (saved)';

export type EconomicsLineKind = 'measured' | 'assumed' | 'externality'

// One economic figure. amount:null = notional (required input unset), never a silent zero.
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
  // True if any summed USD line was notional (null) — keeps $ totals honest, not silently under-reported.
  partial: boolean
}

// A single run's economics — the ?runId= deep-link target. A superset of
// EconomicsSummary (runs:1) enriched with the run identity + authored ticket ids
// the detail view links back to.
export type EconomicsRunDetail = EconomicsSummary & {
  runId: string
  model: string
  at: string // ISO timestamp of the run
  ticketIds: { created: string[]; updated: string[] }
}
