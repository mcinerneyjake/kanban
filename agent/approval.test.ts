import { describe, it, expect } from 'vitest';
import { isApproval, askApproval } from './approval.js';

describe('isApproval', () => {
  it('approves y / yes (case-insensitive, trimmed)', () => {
    for (const a of ['y', 'Y', 'yes', 'YES', '  y  ', 'Yes']) {
      expect(isApproval(a)).toBe(true);
    }
  });
  it('declines anything else', () => {
    for (const a of ['n', 'no', '', '   ', 'maybe', 'yeah', 'yep', 'ok']) {
      expect(isApproval(a)).toBe(false);
    }
  });
});

describe('askApproval', () => {
  it('parses the prompt answer', async () => {
    expect(await askApproval(() => Promise.resolve('y'))).toBe(true);
    expect(await askApproval(() => Promise.resolve('n'))).toBe(false);
  });

  it('declines (fail-safe) when the input stream is closed', async () => {
    expect(await askApproval(() => Promise.reject(new Error('readline was closed')))).toBe(false);
  });
});
