// Blurs the element after POINTER activation only — the sidebar rail expands on :focus-within, so a mouse click leaving a button focused would pin it open. Keyboard activation (Enter/Space) also fires onClick but reports detail===0; blurring then would steal focus to <body> and reset tab order (a11y regression), so gate on non-zero detail.
interface BlurableEvent {
  currentTarget: { blur: () => void }
  detail?: number
}

export function withBlur<E extends BlurableEvent>(
  handler?: (event: E) => void,
): (event: E) => void {
  return (event) => {
    handler?.(event);
    if ((event.detail ?? 0) > 0) event.currentTarget.blur();
  };
}
