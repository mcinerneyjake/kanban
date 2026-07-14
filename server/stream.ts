import type { Request, Response } from 'express';

// SSE hub: the live "something changed, refetch" channel. Owns a module-level Set
// of open responses (stateful, so not in controllers/). registerClient is the
// testable seam (takes any SseClient; a fake works, no socket). Payload is a bare
// 'refresh' signal — no ticket data, so nothing to leak and no diff/rename/delete edge cases.

// The subset of Response the hub uses. Express's Response satisfies it
// structurally (route passes res directly; tests pass a fake) — no cast needed.
export interface SseClient {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): boolean
  end(): void
  // destroyed: true once the socket is gone (Response extends Writable). Optional so tests can omit it.
  readonly destroyed?: boolean
}

const clients = new Set<SseClient>();

// Heartbeat keeps idle connections alive through proxies AND sweeps destroyed
// clients (backstop behind the close/error listeners). Key on destroyed, not
// write()===false — the latter is just backpressure on a live-but-slow client, not death.
const HEARTBEAT_MS = 25_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => writeToAll(': ping\n\n'), HEARTBEAT_MS);
  // Don't let the heartbeat keep the process (or a test runner) alive.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
}

function stopHeartbeat(): void {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

// Write to every client, dropping destroyed sockets (the reliable signal; a
// broken-but-open socket returns false, doesn't throw). try/catch backstops a
// sync throw (write-after-end). Never throws to the caller.
function writeToAll(payload: string): void {
  for (const client of clients) {
    if (client.destroyed) { clients.delete(client); continue; }
    try { client.write(payload); }
    catch { clients.delete(client); }
  }
  if (clients.size === 0) stopHeartbeat();
}

// Register an SSE client: send headers + opening comment, add to the set, return
// an unregister fn. The unit-test seam — drives the hub without a real socket.
export function registerClient(client: SseClient): () => void {
  client.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx and friends) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });
  client.write(': connected\n\n');
  clients.add(client);
  startHeartbeat();
  return () => {
    clients.delete(client);
    if (clients.size === 0) stopHeartbeat();
  };
}

// Broadcast a named SSE event. data is a placeholder {} — the event name is the whole signal.
export function broadcast(event = 'refresh'): void {
  writeToAll(`event: ${event}\ndata: {}\n\n`);
}

// Live client count — for observability and test assertions.
export function streamClientCount(): number {
  return clients.size;
}

// Clean shutdown: end every open response and stop the heartbeat. Idempotent.
export function closeAllStreamClients(): void {
  stopHeartbeat();
  for (const client of clients) {
    try { client.end(); } catch { /* already closed — nothing to do */ }
  }
  clients.clear();
}

// Express adapter: register the response, tear down on close. Not via wrap() —
// the stream never resolves, so the funnel's completion assumptions don't apply.
export function stream(req: Request, res: Response): void {
  const unregister = registerClient(res);
  // Reap on clean disconnect (close) and socket failure (error) — res.write() won't
  // throw on a broken socket, so error catches a proxy drop. unregister is idempotent.
  res.on('close', unregister);
  res.on('error', unregister);
}
