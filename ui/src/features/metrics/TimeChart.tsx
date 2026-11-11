import {
  areaPath,
  chartTop,
  type Domain,
  type Half,
  linePath,
  type Point,
  sampleTime,
  usablePoints,
  VIEW_HEIGHT,
  xTicks,
  yOf,
  yTicks,
} from "./chartGeometry";
import { DASH, formatValue, type MetricUnit } from "./format";
import styles from "./TimeChart.module.css";

export interface ChartSeries {
  name: string;
  points: Point[];
}

export interface TimeChartProps {
  /** Test id stem: `metrics-chart-‹stem›`. */
  stem: string;
  title: string;
  sub: string;
  unit: MetricUnit;
  main: ChartSeries;
  /** Drawn below a middle baseline, as network sent is. */
  mirror: ChartSeries | null;
  /** Dashed reference lines; the caller passes only those that have points. */
  refs: ChartSeries[];
  domain: Domain;
  /** "1 hour", "6 hours", … or "‹N› min" for a rolling chart. */
  period: string;
  /** A chart of days: X ticks and times read "Mon D". */
  days: boolean;
  emptyText: string;
}

const Y_SLOTS = ["0%", "50%", "100%"];

interface RefLabel {
  name: string;
  top: number;
  below: boolean;
}

/**
 * Reference labels sit above their line at its right end; a label near the top, or close
 * under another one, goes below its line instead.
 */
function refLabels(refs: ChartSeries[], top: number, half: Half): RefLabel[] {
  const placed = refs
    .map((ref) => {
      const last = ref.points[ref.points.length - 1];
      return {
        name: ref.name,
        top: (yOf(last[1], top, half) / VIEW_HEIGHT) * 100,
      };
    })
    .sort((a, b) => a.top - b.top);
  return placed.map((label, i) => ({
    ...label,
    below: label.top < 12 || (i > 0 && label.top - placed[i - 1].top < 10),
  }));
}

/** One metric over time: a hand-drawn SVG line chart in a card (spec §7). */
export function TimeChart(props: TimeChartProps) {
  const { domain, unit, stem } = props;
  const main = usablePoints(props.main.points);
  const mirror = props.mirror
    ? { name: props.mirror.name, points: usablePoints(props.mirror.points) }
    : null;
  const refs = props.refs
    .map((ref) => ({ name: ref.name, points: usablePoints(ref.points) }))
    .filter((ref) => ref.points.length > 0);
  const empty = main.length === 0;
  const half: Half = mirror ? "up" : null;
  const top = chartTop(
    [main, mirror?.points ?? [], ...refs.map((ref) => ref.points)],
    unit,
  );
  const last = main[main.length - 1];
  const now = last ? formatValue(last[1], unit) : DASH;

  let aria = `${props.title} over the last ${props.period}: no data.`;
  if (!empty) {
    const peak = main.reduce((best, p) => (p[1] > best[1] ? p : best));
    aria =
      `${props.title} over the last ${props.period}: ${props.main.name} now ${now}, ` +
      `peak ${formatValue(peak[1], unit)} at ${sampleTime(peak[0], props.days)}. ` +
      "Use the arrow keys to read each sample.";
  }

  const chart = (
    <div className={styles.body}>
      <div className={styles.yAxis} aria-hidden="true">
        {empty
          ? null
          : yTicks(top, unit, mirror !== null).map((label, i) => (
              <span
                key={Y_SLOTS[i]}
                className={styles.yTick}
                style={{ top: Y_SLOTS[i] }}
              >
                {label}
              </span>
            ))}
      </div>
      <div
        className={styles.plot}
        role="img"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot is read sample by sample with the arrow keys (spec §7.4).
        tabIndex={0}
        aria-label={aria}
        data-testid={`metrics-chart-${stem}-plot`}
      >
        <svg
          className={styles.svg}
          viewBox="0 0 1000 200"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            className={styles.grid}
            d="M0,0H1000M0,100H1000M0,200H1000"
            vectorEffect="non-scaling-stroke"
          />
          {empty ? null : (
            <>
              <path
                className={styles.area}
                d={areaPath(main, domain, top, half)}
              />
              {mirror ? (
                <path
                  className={styles.area}
                  d={areaPath(mirror.points, domain, top, "down")}
                />
              ) : null}
              {refs.map((ref) => (
                <path
                  key={ref.name}
                  className={styles.ref}
                  d={linePath(ref.points, domain, top, half)}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <path
                className={styles.line}
                d={linePath(main, domain, top, half)}
                vectorEffect="non-scaling-stroke"
              />
              {mirror ? (
                <path
                  className={styles.line}
                  d={linePath(mirror.points, domain, top, "down")}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </>
          )}
        </svg>
        {!empty && mirror ? (
          <>
            <span className={`${styles.halfLabel} ${styles.upLabel}`}>
              {props.main.name}
            </span>
            <span className={`${styles.halfLabel} ${styles.downLabel}`}>
              {mirror.name}
            </span>
          </>
        ) : null}
        {empty
          ? null
          : refLabels(refs, top, half).map((label) => (
              <span
                key={label.name}
                className={`${styles.refLabel} ${label.below ? styles.below : styles.above}`}
                style={{ top: `${label.top}%` }}
              >
                {label.name}
              </span>
            ))}
        {empty ? (
          <p
            className={styles.empty}
            data-testid={`metrics-chart-${stem}-empty`}
          >
            {props.emptyText}
          </p>
        ) : null}
      </div>
      <div />
      <div className={styles.xAxis} aria-hidden="true">
        {xTicks(domain, props.days).map((tick) => (
          <span
            key={tick.at}
            className={styles.xTick}
            style={{ left: `${tick.at * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <section className={styles.card} data-testid={`metrics-chart-${stem}`}>
      <div className={styles.head}>
        <h3 className={styles.title}>{props.title}</h3>
        <span className={styles.sub}>{props.sub}</span>
        <span className={styles.now} data-testid={`metrics-chart-${stem}-now`}>
          {now}
        </span>
      </div>
      {chart}
    </section>
  );
}
