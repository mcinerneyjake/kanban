// Builds the semantic-search query for the create-modal dedup from the form's
// title + body, and gates out inputs too short to be worth a round-trip.
const MIN_QUERY_LENGTH = 6;

export function intakeQuery(title: string, body: string): string | null {
  const text = `${title} ${body}`.trim();
  return text.length >= MIN_QUERY_LENGTH ? text : null;
}
