// Title only — feeding the body would re-fire the search on every keystroke and reflow the modal.
const MIN_QUERY_LENGTH = 6;

export function intakeQuery(title: string): string | null {
  const text = title.trim();
  return text.length >= MIN_QUERY_LENGTH ? text : null;
}
