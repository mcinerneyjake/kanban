import { ApiError } from '../api.js';

// Which failure the draft panel is looking at. Kept out of the component so it is testable, and kept a
// two-way split so the UI can never again answer "is the model running?" for a fault that has nothing to
// do with the model (tkt-a449b3ae0339).
export type DraftFailure = 'model-down' | 'fault'

// 503 is the ONE status the server uses for a runtime it positively identified as unreachable. Anything
// else — a 500 from an in-agent bug, a 400, or a fetch rejection because the kanban server itself is
// unreachable — is not evidence about the model, so it must not be reported as though it were.
export function draftFailureOf(err: unknown): DraftFailure {
  return err instanceof ApiError && err.status === 503 ? 'model-down' : 'fault';
}
