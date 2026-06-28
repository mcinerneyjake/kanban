// Wraps an event handler so the element that received the event is blurred
// afterward — but only for pointer-driven activation. Used on the sidebar's
// controls: the rail expands on :hover/:focus-within, so a mouse click that
// leaves a button focused would pin it open until the user clicked elsewhere.
// Blurring on click keeps the rail's open state tied to pointer position (plus
// the project <select>, which intentionally holds focus while its native
// dropdown is open).
//
// Keyboard activation (Enter/Space) also fires onClick, but blurring then would
// steal focus to <body>, collapse the :focus-within rail, and reset tab order —
// an accessibility regression. Mouse clicks carry a non-zero `detail` (the
// click count); keyboard activation reports `detail === 0`, so we gate on that.
//
// Typed structurally (an event with a blur-able currentTarget and an optional
// numeric detail) so it accepts any React event without depending on React's
// types — and stays trivially unit-testable with a plain object.
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
