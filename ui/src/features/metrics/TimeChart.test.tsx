import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { points, T0 } from "../../test/metrics";
import { clockTime, dayLabel } from "./format";
import { TimeChart, type TimeChartProps } from "./TimeChart";

function props(over: Partial<TimeChartProps> = {}): TimeChartProps {
  return {
    stem: "cpu",
    title: "CPU",
    sub: "of 4 cores on 2 nodes",
    unit: "cores",
    main: { name: "Usage", points: points([0.2, 0.25, 0.3]) },
    mirror: null,
    refs: [],
    domain: { start: T0, end: T0 + 120, step: 60 },
    period: "1 hour",
    days: false,
    emptyText: "No samples in this range.",
    ...over,
  };
}

const plot = () => screen.getByTestId("metrics-chart-cpu-plot");
const paths = (kind: string) =>
  [...plot().querySelectorAll(`path.${kind}`)].map((p) => p.getAttribute("d"));
const texts = (selector: string) =>
  [...screen.getByTestId("metrics-chart-cpu").querySelectorAll(selector)].map(
    (e) => e.textContent,
  );

test("the card shows the title, the sub line and the last value", () => {
  render(<TimeChart {...props()} />);

  const card = screen.getByTestId("metrics-chart-cpu");
  expect(card.querySelector("h3")?.textContent).toBe("CPU");
  expect(card.textContent).toContain("of 4 cores on 2 nodes");
  expect(screen.getByTestId("metrics-chart-cpu-now").textContent).toBe("300m");
});

test("the line and its area are drawn in the series colour", () => {
  render(<TimeChart {...props()} />);

  expect(paths("line")).toEqual(["M0,120L500,100L1000,80"]);
  expect(paths("area")).toEqual(["M0,200L0,120L500,100L1000,80L1000,200Z"]);
  expect(paths("grid")).toEqual(["M0,0H1000M0,100H1000M0,200H1000"]);
  expect(texts(".yTick")).toEqual(["500m", "250m", "0"]);
  expect(texts(".xTick")).toEqual([clockTime(T0), clockTime(T0 + 60)]);
  expect(plot().querySelector("svg")?.getAttribute("viewBox")).toBe(
    "0 0 1000 200",
  );
});

test("reference lines are dashed and labelled at their right end", () => {
  render(
    <TimeChart
      {...props({
        refs: [
          { name: "Requests", points: points([0.5, 0.5, 0.5]) },
          { name: "Limits", points: points([1, 1, 1]) },
        ],
      })}
    />,
  );

  expect(paths("ref")).toEqual([
    "M0,150L500,150L1000,150",
    "M0,100L500,100L1000,100",
  ]);
  expect(texts(".refLabel")).toEqual(["Limits", "Requests"]);
  expect(texts(".yTick")).toEqual(["2 cores", "1 core", "0"]);
});

test("a reference line with no usable point is left out", () => {
  render(
    <TimeChart
      {...props({
        refs: [
          { name: "Requests", points: [] },
          { name: "Limits", points: [[T0, Number.NaN]] },
        ],
      })}
    />,
  );

  expect(paths("ref")).toEqual([]);
  expect(texts(".refLabel")).toEqual([]);
});

test("a close pair of reference labels puts the lower one below its line", () => {
  render(
    <TimeChart
      {...props({
        refs: [
          { name: "Requests", points: points([0.9, 0.9, 0.9]) },
          { name: "Limits", points: points([1, 1, 1]) },
        ],
      })}
    />,
  );

  const [limits, requests] = [
    ...plot().querySelectorAll<HTMLElement>(".refLabel"),
  ];
  expect(limits.textContent).toBe("Limits");
  expect(limits.classList.contains("above")).toBe(true);
  expect(requests.textContent).toBe("Requests");
  expect(requests.classList.contains("below")).toBe(true);
});

test("a mirrored chart draws the second series below the baseline", () => {
  render(
    <TimeChart
      {...props({
        stem: "cpu",
        title: "Network",
        unit: "bytesPerSecond",
        main: { name: "Received", points: points([1024, 2048]) },
        mirror: { name: "Sent", points: points([512, 1024]) },
        domain: { start: T0, end: T0 + 60, step: 60 },
      })}
    />,
  );

  expect(paths("line")).toEqual(["M0,60L1000,20", "M0,120L1000,140"]);
  expect(paths("area")).toEqual([
    "M0,100L0,60L1000,20L1000,100Z",
    "M0,100L0,120L1000,140L1000,100Z",
  ]);
  expect(texts(".yTick")).toEqual(["2.5 KiB/s", "0", "2.5 KiB/s"]);
  expect(texts(".upLabel")).toEqual(["Received"]);
  expect(texts(".downLabel")).toEqual(["Sent"]);
  expect(screen.getByTestId("metrics-chart-cpu-now").textContent).toBe(
    "2 KiB/s",
  );
});

test("a gap in the samples breaks the line", () => {
  render(
    <TimeChart
      {...props({
        main: { name: "Usage", points: points([1, null, null, 2, 2]) },
        domain: { start: T0, end: T0 + 240, step: 60 },
      })}
    />,
  );

  expect(paths("line")).toEqual(["M0,120L0,120M750,40L1000,40"]);
  expect(paths("area")).toEqual([
    "M0,200L0,120L0,200ZM750,200L750,40L1000,40L1000,200Z",
  ]);
});

test("no usable point in the main series: no lines, only the empty text", () => {
  render(
    <TimeChart
      {...props({
        main: {
          name: "Usage",
          points: [
            [T0, Number.NaN],
            [T0 + 60, -1],
          ],
        },
        refs: [{ name: "Requests", points: points([0.5, 0.5]) }],
      })}
    />,
  );

  expect(paths("line")).toEqual([]);
  expect(paths("area")).toEqual([]);
  expect(paths("ref")).toEqual([]);
  expect(texts(".yTick")).toEqual([]);
  expect(screen.getByTestId("metrics-chart-cpu-empty").textContent).toBe(
    "No samples in this range.",
  );
  expect(screen.getByTestId("metrics-chart-cpu-now").textContent).toBe("—");
  expect(plot().getAttribute("aria-label")).toBe(
    "CPU over the last 1 hour: no data.",
  );
});

test("the plot is a focusable image named after its last value and peak", () => {
  render(
    <TimeChart
      {...props({ main: { name: "Usage", points: points([0.2, 0.4, 0.3]) } })}
    />,
  );

  expect(plot().getAttribute("role")).toBe("img");
  expect(plot().tabIndex).toBe(0);
  expect(plot().getAttribute("aria-label")).toBe(
    `CPU over the last 1 hour: Usage now 300m, peak 400m at ${clockTime(T0 + 60)}. Use the arrow keys to read each sample.`,
  );
  expect(screen.queryByTestId("metrics-chart-cpu-empty")).toBeNull();
});

test("a rolling chart names its minutes, and a chart of days its day", () => {
  const { unmount } = render(<TimeChart {...props({ period: "4 min" })} />);
  expect(plot().getAttribute("aria-label")).toMatch(
    /^CPU over the last 4 min: Usage now 300m/,
  );
  unmount();

  render(
    <TimeChart
      {...props({
        period: "7 days",
        days: true,
        domain: { start: T0, end: T0 + 7 * 86_400, step: 3600 },
      })}
    />,
  );
  expect(plot().getAttribute("aria-label")).toContain(
    `peak 300m at ${dayLabel(T0 + 120)} ${clockTime(T0 + 120)}.`,
  );
  expect(texts(".xTick")).toHaveLength(4);
});
