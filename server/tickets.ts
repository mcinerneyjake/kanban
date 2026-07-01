import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { STATUS_IDS, TYPES, PRIORITIES, BOARD_STATUSES, STATUS_STEP, type Ticket, type StatusId, type DashboardSummary } from '../shared/constants.js';
import { appendEvent } from './events.js';

// ---------------------------------------------------------------------------
// Service layer: the ONLY module that touches the filesystem. Routes call
// these functions and stay free of IO/parsing concerns (Route -> Service).
// Source of truth = one Markdown file per ticket in /tickets, e.g. tkt-x9.md
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests can redirect file I/O to a temp directory via this env var.
function getTicketsDir() {
  return process.env.TICKETS_DIR_OVERRIDE ?? path.join(__dirname, '..', 'tickets');
}

// Generated ids only ever match this; we re-check on every path build so a
// crafted :id param can never escape TICKETS_DIR (path-traversal guard).
const ID_RE = /^[a-zA-Z0-9-]+$/;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type TicketPatch = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'order' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>>

// Shape returned by gray-matter after parsing a ticket file. js-yaml will
// auto-parse unquoted ISO dates as Date objects; every other value is string,
// number, or a mixed array depending on the YAML content.
interface RawFrontmatter {
  title?: string | Date
  type?: string
  priority?: string
  status?: string
  order?: number
  created?: string | Date
  updated?: string | Date
  project?: string | null
  blockers?: (string | number | boolean)[]
  parent?: string | null
  dueDate?: string | null
  assignee?: string | null
}

// Explicit-field object passed to matter.stringify — typed so serialize()
// never writes unexpected keys to frontmatter.
interface SerializedFrontmatter {
  title: string
  type: string
  priority: string
  status: string
  order: number
  created: string
  updated: string
  project?: string
  blockers?: string[]
  parent?: string
  dueDate?: string
  assignee?: string
}

async function ensureDir() {
  await fs.mkdir(getTicketsDir(), { recursive: true });
}

function ticketPath(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, `Invalid ticket id: ${id}`);
  return path.join(getTicketsDir(), `${id}.md`);
}

function validEnum<T extends string>(arr: readonly T[], val: string | null | undefined, fallback: T): T {
  const found = arr.find((item) => item === val);
  return found !== undefined ? found : fallback;
}

function assertEnum<T extends string>(arr: readonly T[], val: T | undefined | null, field: string) {
  if (val != null && arr.find((item) => item === val) === undefined)
    throw new HttpError(400, `Invalid ${field}: ${val}`);
}

// gray-matter/js-yaml will happily turn an unquoted ISO date back into a JS
// Date on read. We always want strings, so coerce defensively.
// Explicit typeof guard: gray-matter's data is typed as `any`, so unexpected
// runtime types (e.g. a numeric title: 42 in hand-edited YAML) must not flow
// through `??` as a non-string value.
function asString(v: string | Date | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return '';
}

// Coerce a parsed file into a stable, fully-populated ticket. Unknown/invalid
// enum values fall back to sane defaults so a hand-edited file can't crash the
// board.
function normalize(id: string, data: RawFrontmatter, body: string): Ticket {
  return {
    id,
    title: asString(data.title),
    type: validEnum(TYPES, data.type, 'task'),
    priority: validEnum(PRIORITIES, data.priority, 'medium'),
    status: validEnum(STATUS_IDS, data.status, 'backlog'),
    order: typeof data.order === 'number' ? data.order : 0,
    created: asString(data.created),
    updated: asString(data.updated),
    body: (body || '').trim(),
    project: typeof data.project === 'string' && data.project ? data.project : null,
    blockers: Array.isArray(data.blockers)
      ? data.blockers.filter((v): v is string => typeof v === 'string')
      : [],
    parent: typeof data.parent === 'string' && data.parent ? data.parent : null,
    dueDate: typeof data.dueDate === 'string' && data.dueDate ? data.dueDate : null,
    assignee: typeof data.assignee === 'string' && data.assignee ? data.assignee : null,
  };
}

// Explicit key order -> deterministic, diff-friendly frontmatter.
function serialize(ticket: Ticket): string {
  const data: SerializedFrontmatter = {
    title: ticket.title,
    type: ticket.type,
    priority: ticket.priority,
    status: ticket.status,
    order: ticket.order,
    created: ticket.created,
    updated: ticket.updated,
  };
  if (ticket.project) data.project = ticket.project;
  if (ticket.blockers.length > 0) data.blockers = ticket.blockers;
  if (ticket.parent) data.parent = ticket.parent;
  if (ticket.dueDate) data.dueDate = ticket.dueDate;
  if (ticket.assignee) data.assignee = ticket.assignee;
  return matter.stringify(`\n${ticket.body}\n`, data);
}

// Write via temp file + atomic rename: a crash mid-write leaves the original
// ticket intact instead of a half-written file.
async function writeTicket(ticket: Ticket) {
  await ensureDir();
  const file = ticketPath(ticket.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, serialize(ticket), 'utf8');
  await fs.rename(tmp, file);
}

function validateEnums(patch: TicketPatch) {
  assertEnum(TYPES, patch.type, 'type');
  assertEnum(PRIORITIES, patch.priority, 'priority');
  assertEnum(STATUS_IDS, patch.status, 'status');
}

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// dueDate is hand-editable and accepted from untyped callers; enforce a strict
// YYYY-MM-DD shape on write so a bad value can't reach the UI (where
// formatDueDate would render "undefined NaN") or break the overdue comparison.
function assertDueDate(dueDate: string | null | undefined) {
  if (typeof dueDate === 'string' && !DUE_DATE_RE.test(dueDate))
    throw new HttpError(400, 'dueDate must be YYYY-MM-DD');
}

function newId(): string {
  return `tkt-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}


// --- Public API ------------------------------------------------------------

export async function listTickets(): Promise<Ticket[]> {
  await ensureDir();
  const files = await fs.readdir(getTicketsDir());
  const tickets: Ticket[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(getTicketsDir(), file), 'utf8');
    const { data, content } = matter(raw);
    tickets.push(normalize(file.slice(0, -3), data, content));
  }
  return tickets.sort((a, b) => a.order - b.order);
}

export async function listProjects(): Promise<string[]> {
  const tickets = await listTickets();
  return [...new Set(tickets.map((t) => t.project).filter((p): p is string => Boolean(p)))].sort();
}

export async function getTicket(id: string): Promise<Ticket> {
  const file = ticketPath(id); // validates id BEFORE the try, so a bad id is a
  let raw: string;             // 400 (Invalid id) rather than being masked as a 404.
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new HttpError(404, `Ticket not found: ${id}`);
  }
  const { data, content } = matter(raw);
  return normalize(id, data, content);
}

export async function createTicket(input: Partial<Ticket>): Promise<Ticket> {
  validateEnums(input);
  assertDueDate(input.dueDate);
  if (!input.title || !input.title.trim())
    throw new HttpError(400, 'Title is required');

  const now = new Date().toISOString();
  const all = await listTickets();
  const maxOrder = all.reduce((m, t) => Math.max(m, t.order), 0);

  const ticket = normalize(
    newId(),
    {
      title: input.title.trim(),
      type: input.type ?? 'task',
      priority: input.priority ?? 'medium',
      status: input.status ?? 'backlog',
      order: maxOrder + 1,
      created: now,
      updated: now,
      blockers: input.blockers ?? [],
      project: input.project ?? null,
      parent: input.parent ?? null,
      dueDate: input.dueDate ?? null,
      assignee: input.assignee ?? null,
    },
    input.body ?? '',
  );
  await writeTicket(ticket);
  return ticket;
}

// Reject parent assignments that would create a cycle. Walk the parent→child
// graph from `id`; the new parent may not be `id` itself nor any descendant of
// it. Computed from the current board (the source of truth) so HTTP and MCP
// callers can't persist a cycle that the React client already prevents in the UI.
function collectDescendants(id: string, all: Ticket[]): Set<string> {
  const descendants = new Set<string>();
  const queue: string[] = [id];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const t of all) {
      if (t.parent === cur && !descendants.has(t.id)) {
        descendants.add(t.id);
        queue.push(t.id);
      }
    }
  }
  return descendants;
}

// Best-effort workflow telemetry: a status transition INTO a tracked milestone
// (in-progress/qa/done) records a `reached` event for the tracking UI. This is
// the single choke point both the MCP process and the HTTP PATCH path flow
// through, so the event fires no matter who drives. A telemetry failure must
// never break the ticket write, hence the swallow.
async function emitStatusStep(id: string, status: StatusId): Promise<void> {
  const step = STATUS_STEP[status];
  if (!step) return;
  try {
    await appendEvent({ ticketId: id, step, state: 'reached' });
  } catch (err) {
    console.error('[events] failed to record status step', err);
  }
}

export async function updateTicket(id: string, patch: TicketPatch): Promise<Ticket> {
  validateEnums(patch);
  // `order` is typed number, but HTTP callers pass an untyped body — guard the
  // runtime type so a non-number (e.g. "five") can't be written, then silently
  // coerced to 0 by normalize() on the next read (which reorders the card).
  if (patch.order != null && typeof patch.order !== 'number')
    throw new HttpError(400, 'order must be a number');
  assertDueDate(patch.dueDate);
  const existing = await getTicket(id);
  if (typeof patch.parent === 'string') {
    if (patch.parent === id) throw new HttpError(400, 'A ticket cannot be its own parent');
    if (collectDescendants(id, await listTickets()).has(patch.parent))
      throw new HttpError(400, 'parent would create a cycle');
  }
  // Explicit field-by-field merge: MCP callers pass Record<string, unknown> and
  // bypass TicketPatch typing at compile time. By reading only known fields from
  // patch here, unknown keys from MCP are silently ignored at runtime.
  const merged: Ticket = {
    id,
    title: patch.title ?? existing.title,
    type: patch.type ?? existing.type,
    priority: patch.priority ?? existing.priority,
    status: patch.status ?? existing.status,
    order: patch.order ?? existing.order,
    body: patch.body ?? existing.body,
    // null is a valid patch value (clears the field); undefined means no change
    project: patch.project !== undefined ? patch.project : existing.project,
    blockers: patch.blockers ?? existing.blockers,
    parent: patch.parent !== undefined ? patch.parent : existing.parent,
    dueDate: patch.dueDate !== undefined ? patch.dueDate : existing.dueDate,
    assignee: patch.assignee !== undefined ? patch.assignee : existing.assignee,
    created: existing.created,
    updated: new Date().toISOString(),
  };
  if (!merged.title.trim()) throw new HttpError(400, 'Title is required');
  await writeTicket(merged);
  // Emit only on a real status change — updateTicket is also called for body /
  // priority / reorder patches, which must not record a milestone.
  if (merged.status !== existing.status) await emitStatusStep(id, merged.status);
  return merged;
}

const ARCHIVE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export async function archiveStaleTickets(): Promise<number> {
  const tickets = await listTickets();
  const now = Date.now();
  const stale = tickets.filter((ticket) => {
    if (ticket.status !== 'done') return false;
    const updatedAt = new Date(ticket.updated).getTime();
    return !isNaN(updatedAt) && now - updatedAt >= ARCHIVE_AGE_MS;
  });
  const archived = new Date().toISOString();
  await Promise.all(stale.map((ticket) => writeTicket({ ...ticket, status: 'archived', updated: archived })));
  console.log(`[archive] Archived ${stale.length} stale ticket(s)`);
  return stale.length;
}

export async function searchTickets(q: string): Promise<Ticket[]> {
  const term = q.toLowerCase();
  const tickets = await listTickets();
  return tickets.filter(
    (t) => t.title.toLowerCase().includes(term) || t.body.toLowerCase().includes(term),
  );
}

// Number of rows shown in the dashboard's "recently updated" widget.
const RECENT_LIMIT = 8;

// Pure aggregation over a ticket list — the read-side rollup behind the
// dashboard. Archived tickets are excluded (they're off the active board);
// passing a `project` scopes every count to that project. Kept pure (no IO) so
// it's trivially testable; summarizeBoard() supplies the live ticket list.
export function summarize(tickets: Ticket[], project: string | null = null): DashboardSummary {
  const scoped = tickets.filter(
    (t) => t.status !== 'archived' && (project === null || t.project === project),
  );
  const byStatus = BOARD_STATUSES.map((s) => ({
    status: s.id,
    count: scoped.filter((t) => t.status === s.id).length,
  }));
  const byPriority = PRIORITIES.map((priority) => ({
    priority,
    count: scoped.filter((t) => t.priority === priority).length,
  }));
  const byType = TYPES.map((type) => ({
    type,
    count: scoped.filter((t) => t.type === type).length,
  }));
  // ISO timestamps sort lexicographically = chronologically; newest first.
  const recentlyUpdated = [...scoped]
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, RECENT_LIMIT)
    .map(({ id, title, status, priority, project: p, updated }) => ({
      id, title, status, priority, project: p, updated,
    }));
  return { project, total: scoped.length, byStatus, byPriority, byType, recentlyUpdated };
}

export async function summarizeBoard(project: string | null = null): Promise<DashboardSummary> {
  return summarize(await listTickets(), project);
}

export async function deleteTicket(id: string): Promise<void> {
  const file = ticketPath(id); // validate id before the try (see getTicket)
  try {
    await fs.unlink(file);
  } catch {
    throw new HttpError(404, `Ticket not found: ${id}`);
  }
  // Best-effort referential cleanup: strip the deleted id from every other
  // ticket's *blocker* edges so no dangling blocker reference is left behind.
  // This is housekeeping, not part of delete's contract — the ticket is already
  // gone — so a sweep failure is logged, never propagated (a caller must not see
  // "delete failed" for a ticket that was in fact deleted; the display tolerates
  // a stale edge, and computeActiveBlockerCounts skips ids that resolve to no
  // ticket). Rewrites go via writeTicket with `updated` untouched so cleanup
  // isn't surfaced as an edit. (Parent edges are not swept here — see the
  // parent-on-delete follow-up ticket.)
  try {
    const referencing = (await listTickets()).filter((t) => t.blockers.includes(id));
    await Promise.all(
      referencing.map((t) => writeTicket({ ...t, blockers: t.blockers.filter((b) => b !== id) })),
    );
  } catch (err) {
    console.error(`[delete] blocker cleanup for ${id} failed:`, err);
  }
}
