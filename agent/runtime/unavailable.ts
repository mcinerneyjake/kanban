// "The local runtime could not be reached" as a TYPE, so the HTTP layer can tell it apart from a bug
// inside the agent without matching on message text (tkt-a449b3ae0339).
//
// Direction matters, and it is the whole point: an unrecognised error is NOT unavailability. Claiming
// the runtime is down is the MISLEADING answer — it sends the user to "enter manually" and buries a real
// fault behind "is the model running?", which is exactly the defect this replaces. So recognition must be
// positive, and everything else falls through to a 500 that gets logged.

// Thrown where the runtime's reachability is genuinely known: a request that timed out, or a model the
// runtime says it has not loaded. `cause` keeps the original for the server-side log.
export class RuntimeUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeUnavailableError';
  }
}

// Node/undici connection failures. `fetch` rejects with a TypeError whose `cause` carries the code, so
// the code is the signal and the message is not. ETIMEDOUT is the OS-level connect timeout, distinct
// from AbortSignal.timeout's TimeoutError.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

// Walks the `cause` chain: fetch wraps the real cause one level down, and llm.ts wraps that again to add
// the base URL. Depth-bounded so a self-referential cause cannot spin.
export function isRuntimeUnavailable(err: unknown): boolean {
  for (let node: unknown = err, depth = 0; node !== null && node !== undefined && depth < 8; depth++) {
    if (node instanceof RuntimeUnavailableError) return true;
    if (node instanceof Error) {
      if (node.name === 'TimeoutError') return true; // AbortSignal.timeout fired — the runtime never answered
      if ('code' in node && typeof node.code === 'string' && UNREACHABLE_CODES.has(node.code)) return true;
      node = node.cause;
      continue;
    }
    // A non-Error link (a thrown string/object) carries no reachability evidence.
    return false;
  }
  return false;
}
