import express, { Request, Response, NextFunction } from 'express'
import {
  listTickets,
  listProjects,
  createTicket,
  updateTicket,
  deleteTicket,
  archiveStaleTickets,
  HttpError,
} from './tickets.js'

// Thin routing layer: parse the request, call the service, shape the response.
// No business logic or file IO lives here.
const app = express()
app.use(express.json())

type AsyncHandler = (req: Request, res: Response) => Promise<void>

// Centralised async error funnel so each handler stays a one-liner and every
// thrown HttpError maps to the right status code.
const wrap = (fn: AsyncHandler) => (req: Request, res: Response, _next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(status).json({ error: message })
  })
}

app.get('/api/projects', wrap(async (_req, res) => {
  res.json(await listProjects())
}))

app.get('/api/tickets', wrap(async (_req, res) => {
  res.json(await listTickets())
}))

app.post('/api/tickets', wrap(async (req, res) => {
  res.status(201).json(await createTicket(req.body))
}))

app.patch('/api/tickets/:id', wrap(async (req, res) => {
  res.json(await updateTicket(req.params['id'] as string, req.body))
}))

app.delete('/api/tickets/:id', wrap(async (req, res) => {
  await deleteTicket(req.params['id'] as string)
  res.status(204).end()
}))

app.post('/api/archive', wrap(async (_req, res) => {
  const count = await archiveStaleTickets()
  res.json({ archived: count })
}))

// Schedule archiving every Sunday at 6 PM local time.
function msUntilNextSundayEvening(): number {
  const now = new Date()
  const target = new Date(now)
  const daysUntilSunday = ((7 - now.getDay()) % 7) || 7
  target.setDate(now.getDate() + daysUntilSunday)
  target.setHours(18, 0, 0, 0)
  return target.getTime() - now.getTime()
}

function scheduleWeeklyArchive() {
  const delay = msUntilNextSundayEvening()
  const days = Math.round(delay / 864e5)
  console.log(`[archive] Next run in ~${days} day(s)`)
  setTimeout(async () => {
    try { await archiveStaleTickets() } catch (e) { console.error('[archive] error', e) }
    scheduleWeeklyArchive()
  }, delay)
}

scheduleWeeklyArchive()

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Kanban API → http://localhost:${PORT}`))
