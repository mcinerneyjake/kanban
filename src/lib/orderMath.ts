import type { Ticket } from '../../shared/constants.js';

type OrderEntry = Pick<Ticket, 'id' | 'order'>

const appendOrder = (col: OrderEntry[]): number => {
  const last = col[col.length - 1];
  return last ? last.order + 1 : 1;
};

// Fractional order: inserting between cards takes the midpoint, so a move rewrites exactly ONE ticket file.
export function computeDropOrder(column: OrderEntry[], beforeId: string | null): number {
  if (!beforeId) return appendOrder(column);
  const idx = column.findIndex((t) => t.id === beforeId);
  // Target card moved away (race condition) — fall back to append.
  if (idx === -1) return appendOrder(column);
  const next = column[idx];
  const prev = column[idx - 1];
  const lo = prev ? prev.order : next.order - 1;
  return (lo + next.order) / 2;
}
