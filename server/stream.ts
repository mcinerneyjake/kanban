import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// SSE hub: the live "something changed, refetch" channel for the board.
//
// Deliberately NOT a stateless controller — it owns a module-level Set of open
// responses, so it lives here rather than in controllers/ (which are pure
// request->service->response). The Express adapter (`stream`) is a thin wrapper
// over `registerClient`, which is the testable seam: it takes any SseClient
// (the real Express Response satisfies it structurally) so the hub can be unit-
// tested with a fake client, no socket required.
//
// Payload is a bare `refresh` signal — it carries NO ticket data. Clients react
// by refetching through the normal API. That keeps the stream trivially safe
// (nothing to leak) and dodges every diff/rename/delete edge case a data-
// carrying stream would have. Targeted diffs belong in the pub/sub follow-on.
// ---------------------------------------------------------------------------

// The subset of an http Response the hub actually uses. Express's Response
// satisfies this structurally, so the route passes `res` directly; tests pass a
// minimal fake. Narrow on purpose — no casting needed at either call site.
export interface SseClient {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): boolean
  end(): void
}

const clients = new Set<SseClient>();

// Heartbeat keeps idle connections alive through proxies. Dead clients are
// reaped by the `close`/`error` listeners on the response (see `stream`); a
// write that throws *synchronously* (e.g. write-after-end) also drops the
// client here — but note Node's res.write() on a broken-but-open socket returns
// false / emits an async 'error' rather than throwing, so the listeners, not
// this try/catch, are the primary reap path.
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

// Write to every client, dropping any whose socket has gone away (write throws
// or the client was already half-closed). Never throws to the caller.
function writeToAll(payload: string): void {
  for (const client of clients) {
    try { client.write(payload); }
    catch { clients.delete(client); }
  }
  if (clients.size === 0) stopHeartbeat();
}

// Register an SSE client: send the stream headers + an opening comment, add it
// to the broadcast set, and return an unregister function (call it on close).
// Exported as the unit-test seam — drives the whole hub without a real socket.
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

// Broadcast a named SSE event to all clients. `data` is a placeholder `{}` — the
// event name is the whole signal; clients refetch on it.
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

// Express adapter: register the response and tear it down when the connection
// closes. Not routed through wrap() — this handler never resolves the response
// (the stream stays open), so the error funnel's completion assumptions don't
// apply.
export function stream(req: Request, res: Response): void {
  const unregister = registerClient(res);
  // Reap on both clean disconnect (close) and socket failure (error). Node's
  // res.write() won't throw on a broken-but-open socket, so `error` is the path
  // that catches a proxy dropping the connection without a clean close.
  // unregister is idempotent — a double fire (close after error) is harmless.
  res.on('close', unregister);
  res.on('error', unregister);
}
