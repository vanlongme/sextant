import { expect, test } from "vitest";
import {
  clockTime,
  columnCpu,
  columnMemory,
  DASH,
  dayLabel,
  formatBytes,
  formatCores,
  formatCount,
  formatRate,
  formatValue,
  gibibytes,
  oneDecimal,
  parseQuantity,
  usable,
} from "./format";

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const TIB = 2 ** 40;
const UNUSABLE = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  -0.001,
];

test("usable values are finite and not negative", () => {
  expect([0, 1, 1e12].map((n) => usable(n))).toEqual([true, true, true]);
  expect(UNUSABLE.map((n) => usable(n))).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
});

test("one decimal at most, without a trailing zero", () => {
  expect(
    [2, 1.25, 1.04, 0.04, 0, 15.62, 1023.96].map((n) => oneDecimal(n)),
  ).toEqual(["2", "1.3", "1", "0", "0", "15.6", "1024"]);
});

test("cores read in millicores below one core, then in cores", () => {
  expect(
    [0, 0.0004, 0.004, 0.25, 0.9994, 0.9996, 1, 1.5, 96, 1_000_000].map((n) =>
      formatCores(n),
    ),
  ).toEqual([
    "0m",
    "0m",
    "4m",
    "250m",
    "999m",
    "1 core",
    "1 core",
    "1.5 cores",
    "96 cores",
    "1000000 cores",
  ]);
});

test("bytes read in binary units from KiB to TiB, one decimal at most", () => {
  expect(
    [0, 512, 1024, 1536, 512 * MIB, 1.2 * GIB, 3 * TIB, 2048 * TIB].map((n) =>
      formatBytes(n),
    ),
  ).toEqual([
    "0 KiB",
    "0.5 KiB",
    "1 KiB",
    "1.5 KiB",
    "512 MiB",
    "1.2 GiB",
    "3 TiB",
    "2048 TiB",
  ]);
});

test("a value that rounds to 1024 of a unit reads as 1 of the next", () => {
  expect([1023.96 * MIB, 1023.96 * 1024].map((n) => formatBytes(n))).toEqual([
    "1 GiB",
    "1 MiB",
  ]);
});

test("rates are bytes per second, counts are whole numbers", () => {
  expect([formatRate(3.4 * MIB), formatRate(0), formatRate(512)]).toEqual([
    "3.4 MiB/s",
    "0 KiB/s",
    "0.5 KiB/s",
  ]);
  expect([0, 42, 41.6, 1_234_567].map((n) => formatCount(n))).toEqual([
    "0",
    "42",
    "42",
    "1234567",
  ]);
});

test("formatValue reads each unit", () => {
  expect([
    formatValue(0.25, "cores"),
    formatValue(512 * MIB, "bytes"),
    formatValue(MIB, "bytesPerSecond"),
    formatValue(3, "count"),
  ]).toEqual(["250m", "512 MiB", "1 MiB/s", "3"]);
});

test("GiB without the unit, for the subs and captions", () => {
  expect([16 * GIB, 15.62 * GIB, 0].map((n) => gibibytes(n))).toEqual([
    "16",
    "15.6",
    "0",
  ]);
});

test("columns use the kubectl top style", () => {
  expect([0, 0.004, 0.25, 1.25, 12].map((n) => columnCpu(n))).toEqual([
    "0m",
    "4m",
    "250m",
    "1250m",
    "12000m",
  ]);
  expect(
    [0, 21 * MIB, 1023 * MIB, 1023.6 * MIB, 1.2 * GIB, 2 * GIB].map((n) =>
      columnMemory(n),
    ),
  ).toEqual(["0Mi", "21Mi", "1023Mi", "1.0Gi", "1.2Gi", "2.0Gi"]);
});

test("NaN, infinities and negative values read as a dash everywhere", () => {
  const readers = [
    formatCores,
    formatBytes,
    formatRate,
    formatCount,
    gibibytes,
    columnCpu,
    columnMemory,
    (n: number) => formatValue(n, "cores"),
  ];
  for (const read of readers) {
    expect(UNUSABLE.map((n) => read(n))).toEqual(UNUSABLE.map(() => DASH));
  }
  expect(DASH).toBe("—");
});

test("quantities parse with every suffix and with exponents", () => {
  expect(
    [
      "2",
      "0.5",
      ".5",
      "1500m",
      "250m",
      "100n",
      "5u",
      "2k",
      "3M",
      "4G",
      "1T",
      "1P",
      "1E",
      "1Ki",
      "512Mi",
      "16Gi",
      "2Ti",
      "1Pi",
      "1Ei",
      "1e3",
      "1.5E-3",
      "+2",
      "-1",
    ].map((q) => parseQuantity(q)),
  ).toEqual([
    2,
    0.5,
    0.5,
    1.5,
    0.25,
    1e-7,
    5e-6,
    2000,
    3e6,
    4e9,
    1e12,
    1e15,
    1e18,
    1024,
    512 * MIB,
    16 * GIB,
    2 * TIB,
    2 ** 50,
    2 ** 60,
    1000,
    0.0015,
    2,
    -1,
  ]);
});

test("anything that is not a quantity parses as null", () => {
  expect(
    ["", " ", "abc", "12x", "1.2.3", "Gi", "--1", undefined, null, 5, {}].map(
      (q) => parseQuantity(q),
    ),
  ).toEqual(Array(11).fill(null));
});

test("times read as the local clock and the local day", () => {
  const morning = new Date(2026, 10, 11, 9, 5).getTime() / 1000;
  const night = new Date(2026, 0, 2, 23, 59).getTime() / 1000;

  expect([clockTime(morning), clockTime(night)]).toEqual(["09:05", "23:59"]);
  expect([dayLabel(morning), dayLabel(night)]).toEqual(["Nov 11", "Jan 2"]);
});
