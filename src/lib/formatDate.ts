// Falls back to the raw string on an unparseable value (not "Invalid Date").
export function formatIso(iso: string, format: (d: Date) => string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : format(new Date(t));
}
