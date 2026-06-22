import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listTickets, getTicket, createTicket, updateTicket, deleteTicket, HttpError } from './tickets.js'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-test-'))
  process.env.TICKETS_DIR_OVERRIDE = tmpDir
})

afterAll(async () => {
  delete process.env.TICKETS_DIR_OVERRIDE
  await fs.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  const files = await fs.readdir(tmpDir)
  await Promise.all(
    files.filter((f) => f.endsWith('.md')).map((f) => fs.unlink(path.join(tmpDir, f))),
  )
})

// Awaits a promise expected to reject with HttpError and returns the error.
async function httpError(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(HttpError)
  return err as HttpError
}

// Writes a raw .md file directly into the temp tickets dir.
function makeRaw(title: string, order: number, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    title,
    type: 'task',
    priority: 'medium',
    status: 'backlog',
    order: String(order),
    created: "'2026-01-01T00:00:00.000Z'",
    updated: "'2026-01-01T00:00:00.000Z'",
    ...overrides,
  }
  return ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n')
}

async function writeRaw(id: string, content: string) {
  await fs.writeFile(path.join(tmpDir, `${id}.md`), content, 'utf8')
}

// ---------------------------------------------------------------------------

describe('path-traversal guard', () => {
  it('rejects ../ paths with 400', async () => {
    const err = await httpError(getTicket('../../../etc/passwd'))
    expect(err.status).toBe(400)
  })

  it('rejects ids with slashes with 400', async () => {
    const err = await httpError(getTicket('tkt-abc/def'))
    expect(err.status).toBe(400)
  })

  it('returns 404 for valid-format but missing id', async () => {
    const err = await httpError(getTicket('tkt-doesnotexist'))
    expect(err.status).toBe(404)
  })
})

describe('createTicket validation', () => {
  it('rejects empty title with 400', async () => {
    const err = await httpError(createTicket({ title: '' }))
    expect(err.status).toBe(400)
  })

  it('rejects whitespace-only title with 400', async () => {
    const err = await httpError(createTicket({ title: '   ' }))
    expect(err.status).toBe(400)
  })

  it('rejects invalid type with 400 mentioning "type"', async () => {
    const err = await httpError(createTicket({ title: 'T', type: 'invalid' as never }))
    expect(err.status).toBe(400)
    expect(err.message).toContain('type')
  })

  it('rejects invalid priority with 400 mentioning "priority"', async () => {
    const err = await httpError(createTicket({ title: 'T', priority: 'invalid' as never }))
    expect(err.status).toBe(400)
    expect(err.message).toContain('priority')
  })

  it('rejects invalid status with 400 mentioning "status"', async () => {
    const err = await httpError(createTicket({ title: 'T', status: 'invalid' as never }))
    expect(err.status).toBe(400)
    expect(err.message).toContain('status')
  })
})

describe('createTicket defaults', () => {
  it('applies type/priority/status defaults when omitted', async () => {
    const t = await createTicket({ title: 'Hello' })
    expect(t.type).toBe('task')
    expect(t.priority).toBe('medium')
    expect(t.status).toBe('backlog')
  })
})

describe('normalize coercion', () => {
  it('falls back to "task" for invalid type enum in raw file', async () => {
    await writeRaw('tkt-badtype', makeRaw('Bad type', 1, { type: 'invalid-enum' }))
    const t = await getTicket('tkt-badtype')
    expect(t.type).toBe('task')
  })

  it('coerces unquoted YAML Date fields to ISO strings', async () => {
    // js-yaml auto-parses unquoted ISO timestamps as Date objects; asString() coerces back
    await writeRaw('tkt-datecoerce', [
      '---',
      'title: Date ticket',
      'type: task',
      'priority: medium',
      'status: backlog',
      'order: 1',
      'created: 2026-01-15T10:00:00.000Z',
      'updated: 2026-01-15T10:00:00.000Z',
      '---',
      '',
    ].join('\n'))
    const t = await getTicket('tkt-datecoerce')
    expect(typeof t.created).toBe('string')
    expect(typeof t.updated).toBe('string')
    expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('order assignment', () => {
  it('assigns order 1 on an empty board', async () => {
    const t = await createTicket({ title: 'First' })
    expect(t.order).toBe(1)
  })

  it('assigns maxOrder + 1 when tickets already exist', async () => {
    await writeRaw('tkt-ord1', makeRaw('A', 3))
    await writeRaw('tkt-ord2', makeRaw('B', 7))
    const t = await createTicket({ title: 'New' })
    expect(t.order).toBe(8)
  })
})

describe('updateTicket', () => {
  it('rejects empty title with 400', async () => {
    const t = await createTicket({ title: 'Original' })
    const err = await httpError(updateTicket(t.id, { title: '' }))
    expect(err.status).toBe(400)
  })

  it('returns 404 for nonexistent id', async () => {
    const err = await httpError(updateTicket('tkt-doesnotexist', { title: 'X' }))
    expect(err.status).toBe(404)
  })

  it('partial patch leaves other fields unchanged', async () => {
    const t = await createTicket({ title: 'Keep me', priority: 'high' })
    const updated = await updateTicket(t.id, { status: 'done' })
    expect(updated.title).toBe('Keep me')
    expect(updated.priority).toBe('high')
    expect(updated.status).toBe('done')
  })

  it('advances the updated timestamp', async () => {
    const t = await createTicket({ title: 'Timestamp test' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await updateTicket(t.id, { title: 'Changed' })
    expect(updated.updated).not.toBe(t.updated)
  })
})

describe('deleteTicket', () => {
  it('resolves for an existing ticket, then getTicket returns 404', async () => {
    const t = await createTicket({ title: 'To delete' })
    await expect(deleteTicket(t.id)).resolves.toBeUndefined()
    const err = await httpError(getTicket(t.id))
    expect(err.status).toBe(404)
  })

  it('returns 404 for a nonexistent id', async () => {
    const err = await httpError(deleteTicket('tkt-ghost'))
    expect(err.status).toBe(404)
  })
})

describe('listTickets', () => {
  it('returns tickets sorted by order ascending regardless of filename order', async () => {
    await writeRaw('tkt-zzz', makeRaw('C', 30))
    await writeRaw('tkt-aaa', makeRaw('A', 10))
    await writeRaw('tkt-mmm', makeRaw('B', 20))
    const tickets = await listTickets()
    expect(tickets.map((t) => t.order)).toEqual([10, 20, 30])
  })
})
