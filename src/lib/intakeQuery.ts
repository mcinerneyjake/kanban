// Builds the semantic-search query for the create-modal dedup from the ticket
// title, and gates out titles too short to be worth a round-trip. Title only —
// feeding the body in would re-fire the search on every description keystroke
// and reflow the modal.
const MIN_QUERY_LENGTH = 6;

export function intakeQuery(title: string): string | null {
  const text = title.trim();
  return text.length >= MIN_QUERY_LENGTH ? text : null;
}
