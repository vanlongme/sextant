import { clockTime, dayLabel, formatValue, type MetricUnit } from "./format";

/** The SVG's user space: the plot stretches it to its box. */
export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = 200;

/** A sample: unix seconds and the value. */
export type Point = [number, number];

export interface Domain {
  start: number;
  end: number;
  step: number;
}

/**
 * Which part of the height a series uses: `up` above a middle baseline, `down` mirrored
 * below it, null the whole height.
 */
export type Half = "up" | "down" | null;

/** The smallest top per unit, so an idle or all-zero chart still has a scale. */
const MIN_TOP: Record<MetricUnit, number> = {
  cores: 0.1,
  bytes: 2 ** 20,
  bytesPerSecond: 1024,
  count: 2,
};

const MANTISSAS = [1, 2, 2.5, 5, 10];
/** Counts keep a whole half tick. */
const COUNT_MANTISSAS = [2, 4, 6, 8, 10];

/** Points that can be drawn: finite times and values, no negative value. */
export function usablePoints(points: Point[] | undefined): Point[] {
  return (points ?? []).filter(
    ([t, v]) => Number.isFinite(t) && Number.isFinite(v) && v >= 0,
  );
}

/** The smallest `mantissa × 10^n` at or above `x` (x > 0). */
function niceUp(x: number, mantissas: number[]): number {
  let p = 10 ** Math.floor(Math.log10(x));
  // log10 can land one power off for exact powers of ten.
  if (p * 10 <= x) p *= 10;
  if (p > x) p /= 10;
  for (const m of mantissas) {
    if (m * p >= x * (1 - 1e-12)) return m * p;
  }
  return 10 * p;
}

/**
 * The chart's top: the largest value times 1.1, rounded up to a readable number in the
 * chart's unit, never below the unit's minimum. Bytes round within their binary unit.
 */
export function niceTop(max: number, unit: MetricUnit): number {
  const target = Number.isFinite(max) ? max * 1.1 : 0;
  if (!(target > MIN_TOP[unit])) return MIN_TOP[unit];
  if (unit === "count") return niceUp(target, COUNT_MANTISSAS);
  if (unit === "cores") return niceUp(target, MANTISSAS);
  const k = Math.max(0, Math.floor(Math.log(target) / Math.log(1024)));
  const scale = 1024 ** k;
  return niceUp(target / scale, MANTISSAS) * scale;
}

/** The top that covers every point of a chart's series and reference lines. */
export function chartTop(lists: Point[][], unit: MetricUnit): number {
  let max = 0;
  for (const list of lists) {
    for (const [, v] of usablePoints(list)) max = Math.max(max, v);
  }
  return niceTop(max, unit);
}

export function xOf(t: number, domain: Domain): number {
  const span = domain.end - domain.start;
  return span > 0 ? ((t - domain.start) / span) * VIEW_WIDTH : VIEW_WIDTH;
}

export function yOf(value: number, top: number, half: Half): number {
  const share = value / top;
  if (half === "up") return 100 - share * 100;
  if (half === "down") return 100 + share * 100;
  return VIEW_HEIGHT - share * VIEW_HEIGHT;
}

/** Runs of samples; two neighbours more than 1.5 steps apart start a new run. */
export function segments(points: Point[], step: number): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  for (const point of points) {
    const previous = run[run.length - 1];
    if (previous && point[0] - previous[0] > 1.5 * step) {
      out.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) out.push(run);
  return out;
}

const r = (n: number) => Math.round(n * 10) / 10;

function coords(point: Point, domain: Domain, top: number, half: Half): string {
  return `${r(xOf(point[0], domain))},${r(yOf(point[1], top, half))}`;
}

/**
 * The line through the points, one subpath per run. A lone sample is a zero-length
 * segment, which the round line cap draws as a dot.
 */
export function linePath(
  points: Point[],
  domain: Domain,
  top: number,
  half: Half,
): string {
  return segments(points, domain.step)
    .map((run) => {
      const [first, ...rest] = run.map((p) => coords(p, domain, top, half));
      return `M${first}L${(rest.length > 0 ? rest : [first]).join("L")}`;
    })
    .join("");
}

/** The area under the line, each run closed down (or up, when mirrored) to its baseline. */
export function areaPath(
  points: Point[],
  domain: Domain,
  top: number,
  half: Half,
): string {
  const base = half === null ? VIEW_HEIGHT : VIEW_HEIGHT / 2;
  return segments(points, domain.step)
    .map((run) => {
      const x0 = r(xOf(run[0][0], domain));
      const x1 = r(xOf(run[run.length - 1][0], domain));
      const line = run.map((p) => coords(p, domain, top, half)).join("L");
      return `M${x0},${base}L${line}L${x1},${base}Z`;
    })
    .join("");
}

const TICK_AT = [0.125, 0.375, 0.625, 0.875];

/** Up to four time labels; a label equal to the one before it is left out. */
export function xTicks(
  domain: Domain,
  days: boolean,
): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  for (const at of TICK_AT) {
    const t = domain.start + at * (domain.end - domain.start);
    const label = days ? dayLabel(t) : clockTime(t);
    if (out[out.length - 1]?.label !== label) out.push({ at, label });
  }
  return out;
}

/** The Y labels from top to bottom: top, half and 0, or top, 0 and top when mirrored. */
export function yTicks(
  top: number,
  unit: MetricUnit,
  mirrored: boolean,
): string[] {
  const high = formatValue(top, unit);
  return mirrored ? [high, "0", high] : [high, formatValue(top / 2, unit), "0"];
}

/** The index of the sample nearest to `t`, the first on a tie; -1 without samples. */
export function nearestIndex(points: Point[], t: number): number {
  let best = -1;
  for (const [i, [pt]] of points.entries()) {
    if (best < 0 || Math.abs(pt - t) < Math.abs(points[best][0] - t)) best = i;
  }
  return best;
}

/** A sample's time: `HH:MM`, or `Mon D HH:MM` on a chart of days. */
export function sampleTime(t: number, days: boolean): string {
  return days ? `${dayLabel(t)} ${clockTime(t)}` : clockTime(t);
}
