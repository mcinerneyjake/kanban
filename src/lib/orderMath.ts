import type { Ticket } from '../../shared/constants.js'

// Cards carry a fractional `order`; inserting between two cards takes the
// midpoint of their orders, so a move rewrites exactly ONE ticket file.
export function computeDropOrder(column: Ticket[], beforeId: string | null): number {
  if (!beforeId) {
    const last = column[column.length - 1]
    return last ? last.order + 1 : 1
  }
  const idx = column.findIndex((t) => t.id === beforeId)
  if (idx === -1) {
    // Target card moved away (race condition) — fall back to append.
    const last = column[column.length - 1]
    return last ? last.order + 1 : 1
  }
  const next = column[idx]
  const prev = column[idx - 1]
  const lo = prev ? prev.order : next.order - 1
  return (lo + next.order) / 2
}
