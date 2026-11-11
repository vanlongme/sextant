import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import type { MetricsView } from "../../stores/metrics";
import {
  areaPath,
  chartTop,
  type Domain,
  type Half,
  linePath,
  nearestIndex,
  type Point,
  sampleTime,
  usablePoints,
  VIEW_HEIGHT,
  xOf,
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
  /** Names of series whose metric the backend reported missing: they read "no data". */
  missing: string[];
  emptyText: string;
  /** The store's view: the plot, or a table of the newest samples. */
  view: MetricsView;
}

const Y_SLOTS = ["0%", "50%", "100%"];
const NO_DATA = "no data";
/** The table view lists this many of the newest samples. */
const TABLE_ROWS = 12;

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

/** A series' formatted value at `t`, or "no data" when it is missing or has no sample there. */
function readValue(
  series: ChartSeries,
  t: number,
  unit: MetricUnit,
  missing: string[],
): string {
  if (missing.includes(series.name)) return NO_DATA;
  const point = series.points.find((p) => p[0] === t);
  return point ? formatValue(point[1], unit) : NO_DATA;
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

  // The selected sample: focus picks the last one, keys and hover move it. Esc hides the
  // readout until the next key or hover.
  const [selected, setSelected] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);
  const focused = useRef(false);
  const count = main.length;
  const index =
    selected === null || count === 0 ? null : Math.min(selected, count - 1);
  const sample = index === null || hidden ? null : main[index];

  const pick = (next: number) => {
    setSelected(next);
    setHidden(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    if (event.key === "Escape") {
      // A shown readout takes this Escape, so a drawer around the chart stays open.
      if (sample) {
        event.preventDefault();
        event.stopPropagation();
        setHidden(true);
      }
      return;
    }
    const current = index ?? count - 1;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = Math.max(0, current - 1);
        break;
      case "ArrowRight":
        next = Math.min(count - 1, current + 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    pick(next);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (count === 0 || box.width <= 0) return;
    const share = Math.min(
      1,
      Math.max(0, (event.clientX - box.left) / box.width),
    );
    pick(
      nearestIndex(main, domain.start + share * (domain.end - domain.start)),
    );
  };

  // Every series the readout and the table list, in drawing order.
  const listed = [
    { ...props.main, points: main, dashed: false },
    ...(mirror ? [{ ...mirror, dashed: false }] : []),
    ...refs.map((ref) => ({ ...ref, dashed: true })),
  ];
  const x = sample ? xOf(sample[0], domain) / 10 : 0;
  const dots = sample
    ? [
        { key: "main", list: main, half },
        ...(mirror
          ? [{ key: "mirror", list: mirror.points, half: "down" as const }]
          : []),
      ].flatMap(({ key, list, half: h }) => {
        const point = list.find((p) => p[0] === sample[0]);
        return point
          ? [{ key, top: (yOf(point[1], top, h) / VIEW_HEIGHT) * 100 }]
          : [];
      })
    : [];

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
        onFocus={() => {
          focused.current = true;
          if (count === 0) return;
          setSelected((s) => s ?? count - 1);
          setHidden(false);
        }}
        onBlur={() => {
          focused.current = false;
          setSelected(null);
          setHidden(false);
        }}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          if (!focused.current) setSelected(null);
        }}
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
        {sample ? (
          <>
            <div className={styles.hairline} style={{ left: `${x}%` }} />
            {dots.map((dot) => (
              <span
                key={dot.key}
                className={styles.dot}
                style={{ left: `${x}%`, top: `${dot.top}%` }}
              />
            ))}
            <div
              className={`${styles.readout} ${x > 60 ? styles.flip : ""}`}
              style={{ left: `${x}%` }}
              data-testid={`metrics-chart-${stem}-readout`}
            >
              <span className={styles.readoutTime}>
                {sampleTime(sample[0], props.days)}
              </span>
              {listed.map((series) => (
                <div key={series.name} className={styles.row}>
                  <span
                    className={`${styles.swatch} ${series.dashed ? styles.dashed : ""}`}
                  />
                  <strong className={styles.value}>
                    {readValue(series, sample[0], unit, props.missing)}
                  </strong>{" "}
                  <span className={styles.rowName}>{series.name}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
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

  let table: ReactNode = null;
  if (props.view === "table") {
    const times = main
      .slice(-TABLE_ROWS)
      .map((p) => p[0])
      .reverse();
    table = empty ? (
      <p
        className={styles.tableEmpty}
        data-testid={`metrics-chart-${stem}-empty`}
      >
        {props.emptyText}
      </p>
    ) : (
      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid={`metrics-table-${stem}`}>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {listed.map((series) => (
                <th key={series.name} scope="col">
                  {series.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((t) => (
              <tr key={t}>
                <td>{sampleTime(t, props.days)}</td>
                {listed.map((series) => (
                  <td key={series.name}>
                    {readValue(series, t, unit, props.missing)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className={styles.card} data-testid={`metrics-chart-${stem}`}>
      <div className={styles.head}>
        <h3 className={styles.title}>{props.title}</h3>
        <span className={styles.sub}>{props.sub}</span>
        <span className={styles.now} data-testid={`metrics-chart-${stem}-now`}>
          {now}
        </span>
      </div>
      {table ?? chart}
    </section>
  );
}
