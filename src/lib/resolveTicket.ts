import type { Ticket } from '../../shared/constants.js';

// Resolve a ticket by id, preferring the already-loaded list and falling back to
// a fetch. The dashboard fetches its own aggregates and can surface tickets —
// via polling or a project filter — that App hasn't loaded into its list yet, so
// a list-only lookup would silently dead-click those rows. The fetcher (the
// server's GET /api/tickets/:id) closes that gap.
export async function resolveTicket(
  id: string,
  tickets: Ticket[],
  fetcher: (id: string) => Promise<Ticket>,
): Promise<Ticket> {
  const local = tickets.find((t) => t.id === id);
  return local ?? fetcher(id);
}
