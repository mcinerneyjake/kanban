// Wraps an event handler so the element that received the event is blurred
// immediately afterward. Used on the sidebar's controls: the rail expands on
// :hover/:focus-within, so a click that leaves a button focused would otherwise
// pin it open until the user clicked elsewhere. Blurring on click keeps the
// rail's open state tied purely to pointer position (plus the project <select>,
// which intentionally holds focus while its native dropdown is open).
//
// Typed structurally (just "an event whose currentTarget can blur") so it
// accepts any React event without depending on React's types — and stays
// trivially unit-testable with a plain object.
interface BlurableTarget {
  blur: () => void
}

export function withBlur<E extends { currentTarget: BlurableTarget }>(
  handler?: (event: E) => void,
): (event: E) => void {
  return (event) => {
    handler?.(event);
    event.currentTarget.blur();
  };
}
