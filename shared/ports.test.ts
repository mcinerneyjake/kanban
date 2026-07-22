import { describe, it, expect } from 'vitest';
import { portOffset, apiPort, webPort } from './ports.js';

describe('portOffset', () => {
  it('defaults to 0 when unset', () => {
    expect(portOffset({})).toBe(0);
  });

  it('reads a positive integer offset', () => {
    expect(portOffset({ KANBAN_PORT_OFFSET: '1' })).toBe(1);
    expect(portOffset({ KANBAN_PORT_OFFSET: '17' })).toBe(17);
  });

  // A bad offset must never stop the dev server booting — it reads as "no offset".
  it('treats junk, zero and negative values as no offset', () => {
    for (const v of ['', '  ', 'abc', '-1', '0', '1.5e3', 'NaN']) {
      expect(portOffset({ KANBAN_PORT_OFFSET: v })).toBe(0);
    }
  });
});

describe('apiPort / webPort', () => {
  it('defaults to the documented pair', () => {
    expect(apiPort({})).toBe(3001);
    expect(webPort({})).toBe(5173);
  });

  it('shifts BOTH ports together — the invariant that keeps a worktree talking to its own API', () => {
    const env = { KANBAN_PORT_OFFSET: '2' };
    expect(apiPort(env)).toBe(3003);
    expect(webPort(env)).toBe(5175);
  });

  it('never collides with the base pair for any offset', () => {
    for (let n = 1; n <= 5; n += 1) {
      const env = { KANBAN_PORT_OFFSET: String(n) };
      expect(apiPort(env)).not.toBe(apiPort({}));
      expect(webPort(env)).not.toBe(webPort({}));
    }
  });

  it('lets an explicit PORT win over the offset (deployment sets it)', () => {
    expect(apiPort({ PORT: '8080' })).toBe(8080);
    expect(apiPort({ PORT: '8080', KANBAN_PORT_OFFSET: '3' })).toBe(8080);
  });

  it('falls back to the offset when PORT is junk rather than binding NaN', () => {
    expect(apiPort({ PORT: 'nope', KANBAN_PORT_OFFSET: '1' })).toBe(3002);
    expect(apiPort({ PORT: '0' })).toBe(3001);
  });
});
