import { describe, it, expect, vi } from 'vitest';
import { restoreFocus, type Focusable } from './focusRestore.js';

const el = (isConnected: boolean) => ({ isConnected, focus: vi.fn(() => { /* spy */ }) }) satisfies Focusable;

describe('restoreFocus', () => {
  it('focuses the trigger while it is still in the document', () => {
    const trigger = el(true);
    const fallback = el(true);
    expect(restoreFocus(trigger, () => fallback)).toBe('trigger');
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fallback.focus).not.toHaveBeenCalled(); // the fallback must not fire when it isn't needed
  });

  // The defect: after ticket→ticket navigation the captured trigger is the link that was unmounted with
  // the previous modal. focus() on it silently no-ops, so focus fell to <body>.
  it('falls back when the trigger has been detached', () => {
    const detached = el(false);
    const card = el(true);
    expect(restoreFocus(detached, () => card)).toBe('fallback');
    expect(detached.focus).not.toHaveBeenCalled(); // no point, and calling it would mask the miss
    expect(card.focus).toHaveBeenCalledOnce();
  });

  it('falls back when there was no trigger at all', () => {
    const card = el(true);
    expect(restoreFocus(null, () => card)).toBe('fallback');
    expect(restoreFocus(undefined, () => card)).toBe('fallback');
  });

  it('reports "none" rather than pretending, when neither is available', () => {
    // The three-outcome point: a void return would make this indistinguishable from a successful
    // restore, which is exactly how the original defect stayed invisible.
    expect(restoreFocus(el(false), () => el(false))).toBe('none');
    expect(restoreFocus(el(false), () => null)).toBe('none');
    expect(restoreFocus(null)).toBe('none');
  });

  it('resolves the fallback lazily, so a caller can query the DOM at close time', () => {
    const fallback = vi.fn(() => el(true));
    restoreFocus(el(true), fallback);
    expect(fallback).not.toHaveBeenCalled(); // trigger was live — never asked
    restoreFocus(el(false), fallback);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
