import { describe, it, expect, vi } from 'vitest';
import { withBlur } from './withBlur.js';

// detail >= 1 marks a real pointer click; detail === 0 marks keyboard
// activation (Enter/Space), which must NOT blur.
const click = (blur: () => void) => ({ currentTarget: { blur }, detail: 1 });
const keyboard = (blur: () => void) => ({ currentTarget: { blur }, detail: 0 });

describe('withBlur', () => {
  it('calls the wrapped handler with the event, then blurs on a pointer click', () => {
    const order: string[] = [];
    const blur = vi.fn(() => order.push('blur'));
    const handler = vi.fn(() => order.push('handler'));
    const event = click(blur);

    withBlur(handler)(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['handler', 'blur']); // handler runs before blur
  });

  it('does NOT blur on keyboard activation (detail === 0), but still runs the handler', () => {
    const blur = vi.fn();
    const handler = vi.fn();

    withBlur(handler)(keyboard(blur));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(blur).not.toHaveBeenCalled();
  });

  it('treats a missing detail as non-pointer and does not blur', () => {
    const blur = vi.fn();
    withBlur()({ currentTarget: { blur } });
    expect(blur).not.toHaveBeenCalled();
  });

  it('still blurs a pointer click when no handler is provided', () => {
    const blur = vi.fn();
    withBlur()(click(blur));
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it('passes the event through so handlers can read it', () => {
    let seen: number | null = null;
    const event = { currentTarget: { blur: vi.fn() }, detail: 1, value: 42 };
    withBlur<typeof event>((e) => { seen = e.value; })(event);
    expect(seen).toBe(42);
  });
});
