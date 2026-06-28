import type { Ticket, DashboardSummary } from '../shared/constants.js';

// Rejects with the server's {error} message (or a generic status string) when
// the HTTP response is not ok. Does not intercept network-level fetch()
// rejections (offline, DNS) — those propagate as TypeError and are caught by
// callers. res.json() returns `any`, so .error is directly accessible without
// a cast.
async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  throw new Error(body.error || `Request failed (${res.status})`);
}

// Unwraps a successful JSON response. res.json() returns Promise<any>, which
// is assignable to T without a cast.
const json = async <T>(res: Response): Promise<T> => {
  await throwIfError(res);
  return res.json();
};

const get = <T>(url: string): Promise<T> => fetch(url).then((res) => json<T>(res));

// send() is for endpoints that return a JSON body (POST, PATCH).
// DELETE returns 204 No Content — calling res.json() on an empty body would
// throw a SyntaxError, so remove() uses fetch + throwIfError directly instead.
const send = <T>(url: string, method: string, data?: unknown): Promise<T> =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((res) => json<T>(res));

export interface IntakeMatch { id: string; title: string; status: Ticket['status']; score: number }
export interface IntakeProposal { action: string; args: Record<string, unknown> }
export interface ProposeResult { proposal: IntakeProposal | null; summary: string }

export const api = {
  list: (): Promise<Ticket[]> => get('/api/tickets'),
  dashboard: (project?: string): Promise<DashboardSummary> =>
    get(`/api/dashboard${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  intake: {
    search: (query: string, limit?: number): Promise<{ results: IntakeMatch[] }> =>
      send('/api/intake/search', 'POST', { query, limit }),
    propose: (report: string): Promise<ProposeResult> =>
      send('/api/intake/propose', 'POST', { report }),
    health: (): Promise<{ available: boolean }> => get('/api/intake/health'),
  },
  create: (data: Partial<Ticket>): Promise<Ticket> => send('/api/tickets', 'POST', data),
  update: (id: string, data: Partial<Ticket>): Promise<Ticket> => send(`/api/tickets/${id}`, 'PATCH', data),
  remove: (id: string): Promise<void> =>
    fetch(`/api/tickets/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
      .then(throwIfError),
};
