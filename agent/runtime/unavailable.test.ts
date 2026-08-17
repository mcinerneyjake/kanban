import { describe, it, expect } from 'vitest';
import { RuntimeUnavailableError, isRuntimeUnavailable } from './unavailable.js';

// The direction under test is the whole fix (tkt-a449b3ae0339): recognition must be POSITIVE, so an
// error carrying no evidence about reachability is not unavailability. The permissive answer here is
// "the runtime is down" — it sends the user to manual entry and buries the real fault.
describe('isRuntimeUnavailable — positive identification only', () => {
  const withCode = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

  it('recognises the explicit type', () => {
    expect(isRuntimeUnavailable(new RuntimeUnavailableError('model not loaded'))).toBe(true);
  });

  it('recognises a connection failure through the cause chain', () => {
    // The shape node's fetch actually rejects with — a TypeError whose CAUSE carries the code.
    expect(isRuntimeUnavailable(withCode('ECONNREFUSED'))).toBe(true);
    expect(isRuntimeUnavailable(withCode('ENOTFOUND'))).toBe(true);
    expect(isRuntimeUnavailable(withCode('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
  });

  it('recognises an abort timeout', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(isRuntimeUnavailable(timeout)).toBe(true);
  });

  it('recognises it two levels down, where llm.ts re-wraps to add the base URL', () => {
    const wrapped = new RuntimeUnavailableError('timed out — is the runtime up?', { cause: withCode('ETIMEDOUT') });
    expect(isRuntimeUnavailable(new Error('propose failed', { cause: wrapped }))).toBe(true);
  });

  // The load-bearing cases. Each of these WAS reported as 503 before the fix.
  it('does NOT recognise an opaque error', () => {
    expect(isRuntimeUnavailable(new Error('cannot read properties of undefined'))).toBe(false);
  });

  it('does NOT recognise an error whose MESSAGE merely mentions a connection code', () => {
    // The old test fixture was exactly this, which is why it passed against the broken controller.
    expect(isRuntimeUnavailable(new Error('connect ECONNREFUSED'))).toBe(false);
  });

  it('does NOT recognise an unrecognised code, a non-Error, or nothing', () => {
    expect(isRuntimeUnavailable(withCode('EACCES'))).toBe(false);
    expect(isRuntimeUnavailable('runtime down')).toBe(false);
    expect(isRuntimeUnavailable(null)).toBe(false);
    expect(isRuntimeUnavailable(undefined)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const loop = new Error('round');
    Object.defineProperty(loop, 'cause', { value: loop });
    expect(isRuntimeUnavailable(loop)).toBe(false); // returns rather than spinning
  });
});
