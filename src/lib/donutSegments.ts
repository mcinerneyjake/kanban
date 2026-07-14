// SVG donut geometry: each segment is a stroked circle; negative dashoffset rotates its arc to start where the previous ended.

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

// Generic over K keeps the caller's literal union (e.g. StatusId) without a cast. Zero-count dropped; all-zero yields empty (caller renders an empty-state ring).
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
