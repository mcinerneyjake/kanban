import { describe, it, expect, vi } from 'vitest';
import { withBlur } from './withBlur.js';

describe('withBlur', () => {
  it('calls the wrapped handler with the event, then blurs currentTarget', () => {
    const order: string[] = [];
    const blur = vi.fn(() => order.push('blur'));
    const handler = vi.fn(() => order.push('handler'));
    const event = { currentTarget: { blur } };

    withBlur(handler)(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['handler', 'blur']); // handler runs before blur
  });

  it('still blurs when no handler is provided', () => {
    const blur = vi.fn();
    withBlur()({ currentTarget: { blur } });
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it('passes the event through so handlers can read it', () => {
    let seen: number | null = null;
    const event = { currentTarget: { blur: vi.fn() }, value: 42 };
    withBlur<typeof event>((e) => { seen = e.value; })(event);
    expect(seen).toBe(42);
  });
});
