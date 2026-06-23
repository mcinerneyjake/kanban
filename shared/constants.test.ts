import { describe, it, expect } from 'vitest';
import { isStatusId, isTicketType, isPriority } from './constants.js';

describe('isStatusId', () => {
  it('returns true for every valid status id', () => {
    expect(isStatusId('backlog')).toBe(true);
    expect(isStatusId('todo')).toBe(true);
    expect(isStatusId('in-progress')).toBe(true);
    expect(isStatusId('qa')).toBe(true);
    expect(isStatusId('done')).toBe(true);
    expect(isStatusId('archived')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isStatusId('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isStatusId('')).toBe(false);
  });
});

describe('isTicketType', () => {
  it('returns true for every valid ticket type', () => {
    expect(isTicketType('bug')).toBe(true);
    expect(isTicketType('feature')).toBe(true);
    expect(isTicketType('task')).toBe(true);
    expect(isTicketType('chore')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isTicketType('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isTicketType('')).toBe(false);
  });
});

describe('isPriority', () => {
  it('returns true for every valid priority', () => {
    expect(isPriority('low')).toBe(true);
    expect(isPriority('medium')).toBe(true);
    expect(isPriority('high')).toBe(true);
    expect(isPriority('urgent')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isPriority('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isPriority('')).toBe(false);
  });
});
