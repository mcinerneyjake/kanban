// Dev ports for the API and the Vite server, resolved from one knob so the two can never disagree
// (tkt-4b74943a319e). Concurrent git worktrees each need their own pair: without this, a second
// worktree's Express dies on EADDRINUSE while its Vite silently falls back to the next free port and
// proxies to the FIRST worktree's API — you edit one checkout and exercise another. Deriving both
// ports and the proxy target from a single offset makes that mismatch unrepresentable.

const BASE_API_PORT = 3001;
const BASE_WEB_PORT = 5173;

// Digits-only, deliberately stricter than parseInt: parseInt('1.5e3') is 1, which would hand back a
// plausible-looking offset for input that means nothing. A malformed port is better read as absent.
function readWholeNumber(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// Whole worktrees shift together: KANBAN_PORT_OFFSET=1 → API 3002, web 5174. Junk reads as 0 rather
// than throwing — a bad offset must not stop the dev server booting.
export function portOffset(env: NodeJS.ProcessEnv = process.env): number {
  const n = readWholeNumber(env.KANBAN_PORT_OFFSET);
  return n !== null && n > 0 ? n : 0;
}

// PORT still wins when set explicitly — deployment sets it, and the offset is a dev-only convenience.
export function apiPort(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = readWholeNumber(env.PORT);
  if (explicit !== null && explicit > 0) return explicit;
  return BASE_API_PORT + portOffset(env);
}

export function webPort(env: NodeJS.ProcessEnv = process.env): number {
  return BASE_WEB_PORT + portOffset(env);
}
