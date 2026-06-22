import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { STATUS_IDS, TYPES, PRIORITIES, type Ticket, type StatusId, type TicketType, type Priority } from '../shared/constants.js'

// ---------------------------------------------------------------------------
// Service layer: the ONLY module that touches the filesystem. Routes call
// these functions and stay free of IO/parsing concerns (Route -> Service).
// Source of truth = one Markdown file per ticket in /tickets, e.g. tkt-x9.md
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TICKETS_DIR = path.join(__dirname, '..', 'tickets')

// Generated ids only ever match this; we re-check on every path build so a
// crafted :id param can never escape TICKETS_DIR (path-traversal guard).
const ID_RE = /^[a-z0-9-]+$/

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type TicketPatch = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'order' | 'body'>>

async function ensureDir() {
  await fs.mkdir(TICKETS_DIR, { recursive: true })
}

function ticketPath(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, `Invalid ticket id: ${id}`)
  return path.join(TICKETS_DIR, `${id}.md`)
}

// gray-matter/js-yaml will happily turn an unquoted ISO date back into a JS
// Date on read. We always want strings, so coerce defensively.
function asString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  return v == null ? '' : String(v)
}

// Coerce a parsed file into a stable, fully-populated ticket. Unknown/invalid
// enum values fall back to sane defaults so a hand-edited file can't crash the
// board.
function normalize(id: string, data: Record<string, unknown>, body: string): Ticket {
  return {
    id,
    title: asString(data.title),
    type: (TYPES as readonly string[]).includes(data.type as string) ? data.type as TicketType : 'task',
    priority: (PRIORITIES as readonly string[]).includes(data.priority as string) ? data.priority as Priority : 'medium',
    status: (STATUS_IDS as readonly string[]).includes(data.status as string) ? data.status as StatusId : 'backlog',
    order: typeof data.order === 'number' ? data.order : 0,
    created: asString(data.created),
    updated: asString(data.updated),
    body: (body || '').trim(),
  }
}

// Explicit key order -> deterministic, diff-friendly frontmatter.
function serialize(ticket: Ticket): string {
  const data = {
    title: ticket.title,
    type: ticket.type,
    priority: ticket.priority,
    status: ticket.status,
    order: ticket.order,
    created: ticket.created,
    updated: ticket.updated,
  }
  return matter.stringify(`\n${ticket.body}\n`, data)
}

// Write via temp file + atomic rename: a crash mid-write leaves the original
// ticket intact instead of a half-written file.
async function writeTicket(ticket: Ticket) {
  await ensureDir()
  const file = ticketPath(ticket.id)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, serialize(ticket), 'utf8')
  await fs.rename(tmp, file)
}

function validateEnums(patch: TicketPatch) {
  if (patch.type != null && !(TYPES as readonly string[]).includes(patch.type))
    throw new HttpError(400, `Invalid type: ${patch.type}`)
  if (patch.priority != null && !(PRIORITIES as readonly string[]).includes(patch.priority))
    throw new HttpError(400, `Invalid priority: ${patch.priority}`)
  if (patch.status != null && !(STATUS_IDS as readonly string[]).includes(patch.status))
    throw new HttpError(400, `Invalid status: ${patch.status}`)
}

function newId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')
  return `tkt-${ts}${rand}`
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

// --- Public API ------------------------------------------------------------

export async function listTickets(): Promise<Ticket[]> {
  await ensureDir()
  const files = await fs.readdir(TICKETS_DIR)
  const tickets: Ticket[] = []
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const raw = await fs.readFile(path.join(TICKETS_DIR, file), 'utf8')
    const { data, content } = matter(raw)
    tickets.push(normalize(file.slice(0, -3), data as Record<string, unknown>, content))
  }
  return tickets.sort((a, b) => a.order - b.order)
}

export async function getTicket(id: string): Promise<Ticket> {
  const file = ticketPath(id) // validates id BEFORE the try, so a bad id is a
  let raw: string             // 400 (Invalid id) rather than being masked as a 404.
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    throw new HttpError(404, `Ticket not found: ${id}`)
  }
  const { data, content } = matter(raw)
  return normalize(id, data as Record<string, unknown>, content)
}

export async function createTicket(input: Partial<Ticket>): Promise<Ticket> {
  validateEnums(input)
  if (!input.title || !input.title.trim())
    throw new HttpError(400, 'Title is required')

  const now = new Date().toISOString()
  const all = await listTickets()
  const maxOrder = all.reduce((m, t) => Math.max(m, t.order), 0)

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
    },
    input.body ?? '',
  )
  await writeTicket(ticket)
  return ticket
}

export async function updateTicket(id: string, patch: TicketPatch): Promise<Ticket> {
  validateEnums(patch)
  const existing = await getTicket(id)
  const merged: Ticket = {
    ...existing,
    ...pick(patch, ['title', 'type', 'priority', 'status', 'order', 'body']),
    id,
    created: existing.created,
    updated: new Date().toISOString(),
  }
  if (!merged.title.trim()) throw new HttpError(400, 'Title is required')
  await writeTicket(merged)
  return merged
}

export async function deleteTicket(id: string): Promise<void> {
  const file = ticketPath(id) // validate id before the try (see getTicket)
  try {
    await fs.unlink(file)
  } catch {
    throw new HttpError(404, `Ticket not found: ${id}`)
  }
}
