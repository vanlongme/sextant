import { describe, expect, test } from "vitest";
import { points, T0 } from "../../test/metrics";
import {
  areaPath,
  chartTop,
  linePath,
  nearestIndex,
  niceTop,
  type Point,
  sampleTime,
  segments,
  usablePoints,
  xOf,
  xTicks,
  yOf,
  yTicks,
} from "./chartGeometry";
import { clockTime, dayLabel } from "./format";

const MiB = 2 ** 20;
const GiB = 2 ** 30;

test("usablePoints drops non-finite times and values and negative values", () => {
  const list: Point[] = [
    [T0, 1],
    [T0 + 60, Number.NaN],
    [T0 + 120, Number.POSITIVE_INFINITY],
    [T0 + 180, -0.5],
    [Number.NaN, 2],
    [T0 + 240, 0],
  ];
  expect(usablePoints(list)).toEqual([
    [T0, 1],
    [T0 + 240, 0],
  ]);
  expect(usablePoints(undefined)).toEqual([]);
});

describe("niceTop", () => {
  test.each([
    [0.25, "cores", 0.5],
    [0.9, "cores", 1],
    [3, "cores", 5],
    [96, "cores", 200],
    [700 * MiB, "bytes", 1000 * MiB],
    [1.5 * GiB, "bytes", 2 * GiB],
    [3 * MiB, "bytesPerSecond", 5 * MiB],
    [12, "count", 20],
    [45, "count", 60],
    [1, "count", 2],
  ] as const)("%s %s rounds up to %s", (max, unit, top) => {
    expect(niceTop(max, unit)).toBeCloseTo(top, 9);
  });

  test("all zeros give the unit's minimum top", () => {
    expect(niceTop(0, "cores")).toBe(0.1);
    expect(niceTop(0, "bytes")).toBe(MiB);
    expect(niceTop(0, "bytesPerSecond")).toBe(1024);
    expect(niceTop(0, "count")).toBe(2);
    expect(niceTop(Number.NaN, "cores")).toBe(0.1);
    expect(niceTop(-3, "count")).toBe(2);

    const zeros = points([0, 0, 0]);
    const top = chartTop([zeros], "cores");
    const domain = { start: T0, end: T0 + 120, step: 60 };
    expect(top).toBe(0.1);
    expect(linePath(zeros, domain, top, null)).toBe("M0,200L500,200L1000,200");
  });

  test("the top covers the largest value of the series and its reference lines", () => {
    const usage = points([0.2, 0.3, 0.25]);
    const limits = points([4, 4, 4]);
    const top = chartTop([usage, limits], "cores");
    expect(top).toBe(5);
    expect(yOf(4, top, null)).toBeGreaterThanOrEqual(0);

    const spike = points([0.1, 12, 0.1]);
    const requests = points([0.5, 0.5, 0.5]);
    const spikeTop = chartTop([spike, requests], "cores");
    expect(spikeTop).toBe(20);
    expect(yOf(12, spikeTop, null)).toBeGreaterThanOrEqual(0);

    expect(chartTop([[], [[T0, Number.NaN]]], "bytes")).toBe(MiB);
  });
});

test("xOf and yOf map time and value into the 1000 × 200 view", () => {
  const domain = { start: T0, end: T0 + 3600, step: 60 };
  expect(xOf(T0, domain)).toBe(0);
  expect(xOf(T0 + 1800, domain)).toBe(500);
  expect(xOf(T0 + 3600, domain)).toBe(1000);
  expect(xOf(T0, { start: T0, end: T0, step: 15 })).toBe(1000);

  expect(yOf(0, 4, null)).toBe(200);
  expect(yOf(4, 4, null)).toBe(0);
  expect(yOf(1, 4, "up")).toBe(75);
  expect(yOf(1, 4, "down")).toBe(125);
  expect(yOf(0, 4, "down")).toBe(100);
});

test("a gap of more than 1.5 steps splits the line, and a lone sample still draws", () => {
  const list: Point[] = [
    [T0, 1],
    [T0 + 60, 1],
    [T0 + 240, 2],
  ];
  const domain = { start: T0, end: T0 + 240, step: 60 };
  expect(segments(list, 60)).toEqual([
    [
      [T0, 1],
      [T0 + 60, 1],
    ],
    [[T0 + 240, 2]],
  ]);
  expect(linePath(list, domain, 2, null)).toBe("M0,100L250,100M1000,0L1000,0");
  expect(areaPath(list, domain, 2, null)).toBe(
    "M0,200L0,100L250,100L250,200ZM1000,200L1000,0L1000,200Z",
  );

  // Exactly 1.5 steps apart is still one run.
  expect(
    segments(
      [
        [T0, 1],
        [T0 + 90, 1],
      ],
      60,
    ),
  ).toHaveLength(1);
  expect(segments([], 60)).toEqual([]);
  expect(linePath([], domain, 2, null)).toBe("");
});

test("mirrored halves draw from the middle baseline", () => {
  const domain = { start: T0, end: T0 + 60, step: 60 };
  const received = points([1024, 2048]);
  const sent = points([512, 1024]);
  const top = chartTop([received, sent], "bytesPerSecond");
  expect(top).toBe(2560);
  expect(linePath(received, domain, top, "up")).toBe("M0,60L1000,20");
  expect(linePath(sent, domain, top, "down")).toBe("M0,120L1000,140");
  expect(areaPath(received, domain, top, "up")).toBe(
    "M0,100L0,60L1000,20L1000,100Z",
  );
  expect(areaPath(sent, domain, top, "down")).toBe(
    "M0,100L0,120L1000,140L1000,100Z",
  );
});

test("coordinates are rounded to one decimal", () => {
  const domain = { start: T0, end: T0 + 180, step: 60 };
  expect(linePath(points([1, 2]), domain, 3, null)).toBe("M0,133.3L333.3,66.7");
});

describe("ticks", () => {
  test("four clock labels at the eighths of the domain", () => {
    const domain = { start: T0, end: T0 + 3600, step: 60 };
    expect(xTicks(domain, false)).toEqual([
      { at: 0.125, label: clockTime(T0 + 450) },
      { at: 0.375, label: clockTime(T0 + 1350) },
      { at: 0.625, label: clockTime(T0 + 2250) },
      { at: 0.875, label: clockTime(T0 + 3150) },
    ]);
  });

  test("a label equal to the one before it is left out", () => {
    const domain = { start: T0, end: T0 + 120, step: 60 };
    expect(xTicks(domain, false)).toEqual([
      { at: 0.125, label: clockTime(T0) },
      { at: 0.625, label: clockTime(T0 + 60) },
    ]);
  });

  test("a chart of days labels the day", () => {
    const week = 7 * 86_400;
    const domain = { start: T0, end: T0 + week, step: 3600 };
    expect(xTicks(domain, true).map((t) => t.label)).toEqual(
      [0.125, 0.375, 0.625, 0.875].map((at) => dayLabel(T0 + at * week)),
    );
  });

  test("Y labels read top, half and 0, or top, 0 and top when mirrored", () => {
    expect(yTicks(0.5, "cores", false)).toEqual(["500m", "250m", "0"]);
    expect(yTicks(2 * GiB, "bytes", false)).toEqual(["2 GiB", "1 GiB", "0"]);
    expect(yTicks(20, "count", false)).toEqual(["20", "10", "0"]);
    expect(yTicks(2560, "bytesPerSecond", true)).toEqual([
      "2.5 KiB/s",
      "0",
      "2.5 KiB/s",
    ]);
  });
});

test("nearestIndex finds the closest sample, the first on a tie", () => {
  const list = points([1, 2, 3]);
  expect(nearestIndex([], T0)).toBe(-1);
  expect(nearestIndex(list, T0 - 500)).toBe(0);
  expect(nearestIndex(list, T0 + 70)).toBe(1);
  expect(nearestIndex(list, T0 + 90)).toBe(1);
  expect(nearestIndex(list, T0 + 9999)).toBe(2);
});

test("sampleTime adds the day on a chart of days", () => {
  expect(sampleTime(T0, false)).toBe(clockTime(T0));
  expect(sampleTime(T0, true)).toBe(`${dayLabel(T0)} ${clockTime(T0)}`);
});
