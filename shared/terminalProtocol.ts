// Limits on the terminal WebSocket protocol that BOTH ends must agree on. Shared rather than duplicated:
// the client buffers input against this cap (tkt-13d218c7749d) and the server enforces it, so two copies
// would be a "keep these in sync" comment pretending to be a mechanism.

// Max chars in one `{t:'i',d}` frame. The server drops an oversized frame WHOLE (parseClientFrame), so a
// client that flushes a buffer larger than this trades dropped keystrokes for dropped everything.
export const MAX_INPUT_CHARS = 200_000;
