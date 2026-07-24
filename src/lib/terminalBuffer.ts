// Serialize an xterm terminal buffer into copyable text (tkt-2fa9b657008f). Used by the terminal
// widget's Copy button: a mouse-reporting TUI (Claude) never lets xterm hold a text selection, so
// selection-based copy is impossible — reading the buffer sidesteps it entirely.

// The subset of xterm's IBuffer we read. Kept minimal so the serializer is testable with a fake
// buffer; term.buffer.active satisfies it structurally (no cast needed).
export interface ReadableBuffer {
  readonly length: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

// Join every line, each right-trimmed, with trailing blank lines dropped. '' for an empty/blank buffer.
export function serializeBuffer(buffer: ReadableBuffer): string {
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
  }
  return lines.join('\n').replace(/\n+$/, '');
}
