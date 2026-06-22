import type { Ticket } from '../shared/constants.js'

// Tiny fetch wrapper. Unwraps JSON, surfaces the server's {error} message, and
// tolerates 204 (No Content) from DELETE.
const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Request failed (${res.status})`)
  }
  return res.status === 204 ? null as T : res.json() as Promise<T>
}

const get = <T>(url: string): Promise<T> => fetch(url).then((res) => json<T>(res))

const send = <T>(url: string, method: string, data?: unknown): Promise<T> =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((res) => json<T>(res))

export const api = {
  list: (): Promise<Ticket[]> => get('/api/tickets'),
  create: (data: Partial<Ticket>): Promise<Ticket> => send('/api/tickets', 'POST', data),
  update: (id: string, data: Partial<Ticket>): Promise<Ticket> => send(`/api/tickets/${id}`, 'PATCH', data),
  remove: (id: string): Promise<null> => send(`/api/tickets/${id}`, 'DELETE'),
  projects: (): Promise<string[]> => get('/api/projects'),
}
