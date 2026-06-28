// Pure geometry for the dashboard's SVG donut chart. Each segment is rendered
// as a stroked <circle> whose `stroke-dasharray` draws one arc and whose
// negative `stroke-dashoffset` rotates it to start where the previous arc ended.
// Keeping the math here (out of the component) makes it unit-testable.

export interface DonutInput<K extends string = string> {
  key: K
  count: number
}

export interface DonutSegment<K extends string = string> {
  key: K
  count: number
  pct: number // share of the total, 0..1
  dashArray: string // `${arc} ${gap}` for stroke-dasharray
  dashOffset: number // negative cumulative arc length for stroke-dashoffset
}

// Maps counts to drawable arc segments around a circle of the given
// circumference. Generic over the key type so callers keep their literal union
// (e.g. StatusId) without a cast. Zero-count entries are dropped (nothing to
// draw); when every count is zero the result is empty and the caller renders an
// empty-state ring.
export function donutSegments<K extends string>(items: DonutInput<K>[], circumference: number): DonutSegment<K>[] {
  const total = items.reduce((sum, i) => sum + i.count, 0);
  if (total <= 0) return [];
  let acc = 0;
  const segments: DonutSegment<K>[] = [];
  for (const item of items) {
    if (item.count <= 0) continue;
    const pct = item.count / total;
    const arc = pct * circumference;
    segments.push({
      key: item.key,
      count: item.count,
      pct,
      dashArray: `${arc} ${circumference - arc}`,
      dashOffset: -acc,
    });
    acc += arc;
  }
  return segments;
}
