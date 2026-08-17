import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from './api.js';

// Drives throwIfError through a real api call. Asserting on a hand-built ApiError instead would leave
// the client free to throw a plain Error and still pass — the "consulted but not wired" shape, found by
// mutating the throw here and watching draftFailure's suite stay green (tkt-a449b3ae0339).
afterEach(() => { vi.unstubAllGlobals(); });

const respond = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }))));

describe('api error shape', () => {
  it('attaches the HTTP status to the thrown error', async () => {
    respond(503, { error: 'Intake unavailable: connect ECONNREFUSED' });
    await expect(api.intake.propose('a report')).rejects.toMatchObject({
      status: 503,
      message: 'Intake unavailable: connect ECONNREFUSED',
    });
  });

  it('throws an ApiError, the type the UI branches on', async () => {
    respond(500, { error: 'Internal server error' });
    const err: unknown = await api.intake.propose('a report').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err instanceof ApiError ? err.status : null).toBe(500);
  });

  it('still carries the status when the body has no error field', async () => {
    respond(502, {});
    await expect(api.intake.propose('a report')).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' });
  });
});
