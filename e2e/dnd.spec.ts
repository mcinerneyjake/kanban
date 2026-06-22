import { test, expect, type Page, type Locator, type APIRequestContext } from 'playwright/test'

const API = 'http://localhost:3001/api'

// ── helpers ──────────────────────────────────────────────────────────────────

async function createTicket(
  request: APIRequestContext,
  title: string,
  status: string,
  order: number,
): Promise<string> {
  const res = await request.post(`${API}/tickets`, { data: { title, status, order } })
  const body = await res.json()
  return body.id as string
}

async function getTicketList(request: APIRequestContext) {
  const res = await request.get(`${API}/tickets`)
  return res.json() as Promise<Array<{ id: string; order: number; status: string }>>
}

async function deleteTicket(request: APIRequestContext, id: string) {
  await request.delete(`${API}/tickets/${id}`)
}

// Dispatch HTML5 drag events inside the browser using a shared DataTransfer so
// the drop handler can read the ticket id that dragstart wrote.
async function dnd(page: Page, src: Locator, tgt: Locator) {
  const [srcEl, tgtEl] = await Promise.all([src.elementHandle(), tgt.elementHandle()])
  if (!srcEl || !tgtEl) throw new Error('dnd: could not resolve element handles')
  await page.evaluate(([s, t]) => {
    const dt = new DataTransfer()
    s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    s.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }))
  }, [srcEl, tgtEl] as [Element, Element])
}

function card(page: Page, title: string) {
  return page.locator('.card', { hasText: title })
}

function col(page: Page, label: string) {
  return page.locator('.column', { has: page.locator('.column-header', { hasText: label }) })
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const createdIds: string[] = []

test.beforeEach(async ({ page }) => {
  createdIds.length = 0
  await page.goto('/')
})

test.afterEach(async ({ request }) => {
  for (const id of createdIds) await deleteTicket(request, id)
})

// ── tests ─────────────────────────────────────────────────────────────────────

test('reorder within column: ALPHA drops below BETA', async ({ page, request }) => {
  const alphaId = await createTicket(request, 'DND-ALPHA', 'backlog', 100)
  const betaId = await createTicket(request, 'DND-BETA', 'backlog', 200)
  createdIds.push(alphaId, betaId)
  await page.reload()

  const backlog = col(page, 'Backlog')
  // Drop ALPHA on the column header → column-level handler fires with beforeId=null → appends to end
  const patchDone = page.waitForResponse(
    (r) => r.url().includes('/api/tickets/') && r.request().method() === 'PATCH',
  )
  await dnd(page, card(page, 'DND-ALPHA'), backlog.locator('.column-header'))
  await patchDone

  // DOM: BETA should appear above ALPHA
  const positions = await backlog.locator('.card').evaluateAll((els) =>
    els.map((el, i) => ({ i, title: el.querySelector('.card-title')?.textContent ?? '' })),
  )
  const betaPos = positions.find((x) => x.title === 'DND-BETA')?.i ?? -1
  const alphaPos = positions.find((x) => x.title === 'DND-ALPHA')?.i ?? -1
  expect(betaPos).toBeGreaterThanOrEqual(0)
  expect(alphaPos).toBeGreaterThan(betaPos)

  // API: ALPHA.order > BETA.order
  const tickets = await getTicketList(request)
  const alpha = tickets.find((t) => t.id === alphaId)!
  const beta = tickets.find((t) => t.id === betaId)!
  expect(alpha.order).toBeGreaterThan(beta.order)
})

test('move to different column: GAMMA lands in Todo', async ({ page, request }) => {
  const gammaId = await createTicket(request, 'DND-GAMMA', 'backlog', 150)
  createdIds.push(gammaId)
  await page.reload()

  const todo = col(page, 'Todo')
  const patchDone = page.waitForResponse(
    (r) => r.url().includes('/api/tickets/') && r.request().method() === 'PATCH',
  )
  await dnd(page, card(page, 'DND-GAMMA'), todo.locator('.column-header'))
  await patchDone

  // DOM: card appears in Todo column
  await expect(todo.locator('.card', { hasText: 'DND-GAMMA' })).toBeVisible()

  // API: status is 'todo'
  const tickets = await getTicketList(request)
  expect(tickets.find((t) => t.id === gammaId)?.status).toBe('todo')
})

test('midpoint math: THIRD inserts between FIRST and SECOND', async ({ page, request }) => {
  const firstId = await createTicket(request, 'DND-FIRST', 'backlog', 100)
  const secondId = await createTicket(request, 'DND-SECOND', 'backlog', 200)
  const thirdId = await createTicket(request, 'DND-THIRD', 'backlog', 300)
  createdIds.push(firstId, secondId, thirdId)
  await page.reload()

  // Dropping THIRD on SECOND → insert THIRD before SECOND → order = (100+200)/2 = 150
  const patchDone = page.waitForResponse(
    (r) => r.url().includes('/api/tickets/') && r.request().method() === 'PATCH',
  )
  await dnd(page, card(page, 'DND-THIRD'), card(page, 'DND-SECOND'))
  await patchDone

  const tickets = await getTicketList(request)
  const first = tickets.find((t) => t.id === firstId)!
  const second = tickets.find((t) => t.id === secondId)!
  const third = tickets.find((t) => t.id === thirdId)!
  expect(third.order).toBeGreaterThan(first.order)
  expect(third.order).toBeLessThan(second.order)
})
