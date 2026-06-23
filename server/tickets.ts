import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { STATUS_IDS, TYPES, PRIORITIES, type Ticket } from '../shared/constants.js';

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

type TicketPatch = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'order' | 'body' | 'project' | 'blockers' | 'parent'>>

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
    },
    input.body ?? '',
  );
  await writeTicket(ticket);
  return ticket;
}

export async function updateTicket(id: string, patch: TicketPatch): Promise<Ticket> {
  validateEnums(patch);
  const existing = await getTicket(id);
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
    created: existing.created,
    updated: new Date().toISOString(),
  };
  if (!merged.title.trim()) throw new HttpError(400, 'Title is required');
  await writeTicket(merged);
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

export async function deleteTicket(id: string): Promise<void> {
  const file = ticketPath(id); // validate id before the try (see getTicket)
  try {
    await fs.unlink(file);
  } catch {
    throw new HttpError(404, `Ticket not found: ${id}`);
  }
}
