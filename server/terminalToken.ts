import { randomUUID } from 'node:crypto';

// Per-boot terminal token. The page fetches it from GET /api/terminal/token (same-origin,
// so a cross-site page can't read the response) and echoes it as the WS subprotocol.
// Kept in its own module (no node-pty/ws deps) so the token route can import it without
// pulling the native transport into the default server/test path.
const TOKEN = randomUUID();

export function terminalToken(): string {
  return TOKEN;
}
