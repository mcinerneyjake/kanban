import { describe, it, expect } from 'vitest';
import { draftFailureOf } from './draftFailure.js';
import { ApiError } from '../api.js';

// 503 is the only status that means "the runtime was positively identified as unreachable". Before
// tkt-a449b3ae0339 the API client dropped the status entirely, so the panel could not tell these apart
// and answered "is the model running?" for all of them.
describe('draftFailureOf', () => {
  it('reads a 503 as the model being down', () => {
    expect(draftFailureOf(new ApiError('Intake unavailable: connect ECONNREFUSED', 503))).toBe('model-down');
  });

  it('reads a 500 as a fault, not the model', () => {
    expect(draftFailureOf(new ApiError('Internal server error', 500))).toBe('fault');
  });

  it('reads any other status as a fault', () => {
    for (const status of [400, 404, 429, 502]) {
      expect(draftFailureOf(new ApiError('nope', status)), String(status)).toBe('fault');
    }
  });

  it('reads a bare fetch rejection as a fault — an unreachable kanban server says nothing about the model', () => {
    expect(draftFailureOf(new TypeError('Failed to fetch'))).toBe('fault');
    expect(draftFailureOf(new Error('Request failed (503)'))).toBe('fault'); // status in the TEXT is not the status
  });
});
