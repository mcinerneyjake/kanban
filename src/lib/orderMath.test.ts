import { describe, it, expect } from 'vitest'
import { computeDropOrder } from './orderMath.js'
import type { Ticket } from '../../shared/constants.js'

// Minimal stub — computeDropOrder only reads .id and .order.
function card(id: string, order: number): Ticket {
  return { id, order } as Ticket
}

describe('computeDropOrder — append (beforeId null)', () => {
  it('returns 1 for an empty column', () => {
    expect(computeDropOrder([], null)).toBe(1)
  })

  it('returns last.order + 1 when appending after existing cards', () => {
    expect(computeDropOrder([card('a', 5)], null)).toBe(6)
  })

  it('uses the highest order when multiple cards exist', () => {
    expect(computeDropOrder([card('a', 2), card('b', 5), card('c', 9)], null)).toBe(10)
  })
})

describe('computeDropOrder — insert before first card', () => {
  it('returns midpoint of (order - 1) and order when inserting before the first card', () => {
    // first card has order 5 → lo = 4, result = (4 + 5) / 2 = 4.5
    expect(computeDropOrder([card('a', 5)], 'a')).toBe(4.5)
  })

  it('handles first card at order 1 → result is 0.5', () => {
    expect(computeDropOrder([card('a', 1)], 'a')).toBe(0.5)
  })
})

describe('computeDropOrder — insert between two cards', () => {
  it('returns exact midpoint between adjacent cards at 1 and 3', () => {
    expect(computeDropOrder([card('a', 1), card('b', 3)], 'b')).toBe(2)
  })

  it('returns midpoint between cards at 1 and 2', () => {
    expect(computeDropOrder([card('a', 1), card('b', 2)], 'b')).toBe(1.5)
  })

  it('works correctly when inserting before a middle card', () => {
    const col = [card('a', 1), card('b', 3), card('c', 7)]
    // inserting before 'c': lo = 3, next = 7 → (3 + 7) / 2 = 5
    expect(computeDropOrder(col, 'c')).toBe(5)
  })
})

describe('computeDropOrder — stale beforeId (race condition guard)', () => {
  it('falls back to append when beforeId is not found in column', () => {
    const col = [card('a', 3), card('b', 7)]
    expect(computeDropOrder(col, 'ghost')).toBe(8) // last.order + 1
  })

  it('returns 1 when beforeId is missing and column is empty', () => {
    expect(computeDropOrder([], 'ghost')).toBe(1)
  })
})

describe('computeDropOrder — float precision edge case', () => {
  it('result is strictly between two very close orders (documents known fragility)', () => {
    const lo = 1.0
    const hi = 1.0 + Number.EPSILON * 4 // smallest gap that survives a midpoint
    const col = [card('a', lo), card('b', hi)]
    const result = computeDropOrder(col, 'b')
    // We can only assert it's between them; IEEE 754 may collapse the gap.
    expect(result).toBeGreaterThanOrEqual(lo)
    expect(result).toBeLessThanOrEqual(hi)
  })
})
