import type { Ticket } from '../../shared/constants.js';

// Prefer the loaded list, fall back to a fetch — the dashboard can surface tickets App hasn't loaded, which a list-only lookup would dead-click.
export async function resolveTicket(
  id: string,
  tickets: Ticket[],
  fetcher: (id: string) => Promise<Ticket>,
): Promise<Ticket> {
  const local = tickets.find((t) => t.id === id);
  return local ?? fetcher(id);
}
