import { describe, it, expect } from 'vitest'
import { msUntilNextSundayEvening } from './index.js'

// Build a Date for a given day-of-week and hour (local time).
// day: 0=Sun, 1=Mon, ... 6=Sat
function at(day: number, hour: number): Date {
  const d = new Date()
  const diff = (day - d.getDay() + 7) % 7
  d.setDate(d.getDate() + diff)
  d.setHours(hour, 0, 0, 0)
  return d
}

describe('msUntilNextSundayEvening', () => {
  it('Sunday before 6 PM — fires the same evening, not next week', () => {
    const now = at(0, 15) // Sunday 3 PM
    const ms = msUntilNextSundayEvening(now)
    // Should be ~3 hours, not ~7 days
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThan(4 * 60 * 60 * 1000) // < 4 hours
  })

  it('Sunday at exactly 6 PM — schedules next Sunday (already past)', () => {
    const now = at(0, 18) // Sunday 6 PM sharp
    const ms = msUntilNextSundayEvening(now)
    // setHours(18,0,0,0) on the same day gives target === now → 0 ms
    // The || 7 branch kicks in for day===0 after-18 → next Sunday
    expect(ms).toBeGreaterThan(6 * 24 * 60 * 60 * 1000) // > 6 days
    expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000) // ≤ 7 days
  })

  it('Sunday after 6 PM — schedules next Sunday', () => {
    const now = at(0, 20) // Sunday 8 PM
    const ms = msUntilNextSundayEvening(now)
    expect(ms).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000)
  })

  it('Monday — schedules 6 days out', () => {
    const now = at(1, 12) // Monday noon
    const ms = msUntilNextSundayEvening(now)
    const sixDaysMs = 6 * 24 * 60 * 60 * 1000
    expect(ms).toBeGreaterThan(sixDaysMs - 60_000)
    expect(ms).toBeLessThan(sixDaysMs + 6 * 60 * 60 * 1000 + 60_000)
  })

  it('Saturday — schedules 1 day out', () => {
    const now = at(6, 12) // Saturday noon
    const ms = msUntilNextSundayEvening(now)
    const oneDayMs = 24 * 60 * 60 * 1000
    expect(ms).toBeGreaterThan(oneDayMs - 60_000)
    expect(ms).toBeLessThan(oneDayMs + 6 * 60 * 60 * 1000 + 60_000)
  })

  it('always returns a positive delay', () => {
    for (let day = 0; day < 7; day++) {
      for (const hour of [0, 6, 12, 17, 18, 23]) {
        expect(msUntilNextSundayEvening(at(day, hour))).toBeGreaterThan(0)
      }
    }
  })
})
