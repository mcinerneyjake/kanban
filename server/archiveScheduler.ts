import { archiveStaleTickets } from './tickets.js';

// Weekly archive sweep — isolated from HTTP assembly, testable without the app.

// Next Sunday 6 PM local. Exported for testing — pass `now` to avoid a real-clock dependency.
export function msUntilNextSundayEvening(now = new Date()): number {
  const target = new Date(now);
  const day = now.getDay();
  // If it's Sunday and 6 PM hasn't passed yet, fire today; otherwise next Sunday.
  const daysUntilSunday = day === 0 && now.getHours() < 18 ? 0 : (7 - day) % 7 || 7;
  target.setDate(now.getDate() + daysUntilSunday);
  target.setHours(18, 0, 0, 0);
  return target.getTime() - now.getTime();
}

let archiveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleWeeklyArchive(): void {
  const delay = msUntilNextSundayEvening();
  const days = Math.round(delay / 864e5);
  console.log(`[archive] Next run in ~${days} day(s)`);
  archiveTimer = setTimeout(async () => {
    try { await archiveStaleTickets(); } catch (e) { console.error('[archive] error', e); }
    scheduleWeeklyArchive();
  }, delay);
}

export function stopArchiveScheduler(): void {
  if (archiveTimer) { clearTimeout(archiveTimer); archiveTimer = null; }
}
