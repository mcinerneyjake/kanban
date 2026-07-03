// Pure geometry for the economics time-series chart — maps a value series to SVG
// coordinates in a viewBox, so the component stays declarative and the math is
// unit-testable (mirrors src/lib/donutSegments.ts). Index → x (evenly spaced),
// value → y (min at the bottom, max at the top; a flat series sits on the
// midline rather than dividing by a zero range).

export interface LinePoint { x: number; y: number }

export interface LineChartInput {
  values: number[];
  width: number;
  height: number;
  pad?: number; // inset from every edge, so markers/strokes aren't clipped
}

export function linePoints({ values, width, height, pad = 0 }: LineChartInput): LinePoint[] {
  const n = values.length;
  if (n === 0) return [];

  const innerW = Math.max(0, width - 2 * pad);
  const innerH = Math.max(0, height - 2 * pad);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  return values.map((v, i) => ({
    x: n === 1 ? width / 2 : pad + (i / (n - 1)) * innerW,
    // Flat series (range 0) → midline; otherwise scale so max is at the top.
    y: range === 0 ? height / 2 : pad + innerH - ((v - min) / range) * innerH,
  }));
}

// An SVG polyline path ("M x y L x y …") through the points.
export function toLinePath(points: LinePoint[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
}

// A closed area path: the line, dropped to `baselineY` at both ends. Empty when
// there are no points.
export function toAreaPath(points: LinePoint[], baselineY: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${toLinePath(points)} L${last.x} ${baselineY} L${first.x} ${baselineY} Z`;
}
