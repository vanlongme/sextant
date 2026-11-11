/**
 * How metric values read (spec D2 §6). Usage is never negative, so a negative value, NaN
 * or an infinity reads as a dash rather than as a number that would mislead.
 */

/** CPU in cores; memory and disk in bytes; network in bytes per second; Pods as counts. */
export type MetricUnit = "cores" | "bytes" | "bytesPerSecond" | "count";

/** What a value reads when there is none to show. */
export const DASH = "—";

const KIB = 1024;
const MIB = 2 ** 20;
const GIB = 2 ** 30;
const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** A value usage can have: finite and not negative. */
export function usable(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** At most one decimal, without a trailing ".0": 1.25 → "1.3", 2 → "2". */
export function oneDecimal(n: number): string {
  const text = n.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** Millicores below one core ("250m"), then cores with one decimal at most ("1.5 cores"). */
export function formatCores(cores: number): string {
  if (!usable(cores)) return DASH;
  const millis = Math.round(cores * 1000);
  if (millis < 1000) return `${millis}m`;
  const text = oneDecimal(cores);
  return text === "1" ? "1 core" : `${text} cores`;
}

/** Binary units from KiB to TiB, one decimal at most ("512 MiB", "1.2 GiB"). */
export function formatBytes(bytes: number): string {
  if (!usable(bytes)) return DASH;
  let unit = 0;
  let value = bytes / KIB;
  while (unit < BYTE_UNITS.length - 1 && value >= KIB) {
    value /= KIB;
    unit += 1;
  }
  // 1023.96 MiB rounds to 1024; it reads "1 GiB" instead.
  if (unit < BYTE_UNITS.length - 1 && Number(value.toFixed(1)) >= KIB) {
    value /= KIB;
    unit += 1;
  }
  return `${oneDecimal(value)} ${BYTE_UNITS[unit]}`;
}

/** Bytes per second ("3.4 MiB/s"). */
export function formatRate(bytesPerSecond: number): string {
  if (!usable(bytesPerSecond)) return DASH;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Whole numbers ("42"). */
export function formatCount(n: number): string {
  if (!usable(n)) return DASH;
  return String(Math.round(n));
}

export function formatValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case "cores":
      return formatCores(value);
    case "bytes":
      return formatBytes(value);
    case "bytesPerSecond":
      return formatRate(value);
    case "count":
      return formatCount(value);
  }
}

/** GiB with one decimal at most, without the unit: "of 15.6 GiB" and the gauge captions. */
export function gibibytes(bytes: number): string {
  if (!usable(bytes)) return DASH;
  return oneDecimal(bytes / GIB);
}

/** The CPU column, as `kubectl top` writes it: always millicores ("4m", "1250m"). */
export function columnCpu(cores: number): string {
  if (!usable(cores)) return DASH;
  return `${Math.round(cores * 1000)}m`;
}

/** The Memory column: Mi below 1024 Mi ("21Mi"), else Gi with one decimal ("1.2Gi"). */
export function columnMemory(bytes: number): string {
  if (!usable(bytes)) return DASH;
  const mebibytes = Math.round(bytes / MIB);
  if (mebibytes < 1024) return `${mebibytes}Mi`;
  return `${(bytes / GIB).toFixed(1)}Gi`;
}

/** Decimal suffixes as powers of ten; the small ones divide, so "1500m" is exactly 1.5. */
const DECIMAL_EXPONENTS: Record<string, number> = {
  n: -9,
  u: -6,
  m: -3,
  "": 0,
  k: 3,
  M: 6,
  G: 9,
  T: 12,
  P: 15,
  E: 18,
};
const BINARY_EXPONENTS: Record<string, number> = {
  Ki: 10,
  Mi: 20,
  Gi: 30,
  Ti: 40,
  Pi: 50,
  Ei: 60,
};
const QUANTITY =
  /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]))?$/;

/** A Kubernetes quantity ("1500m", "16Gi", "1e3") as a number; null when it is not one. */
export function parseQuantity(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const match = QUANTITY.exec(text.trim());
  if (!match) return null;
  const [, number, exponent, suffix = ""] = match;
  if (exponent) return Number(`${number}${exponent}`);
  const value = Number(number);
  if (suffix in BINARY_EXPONENTS) return value * 2 ** BINARY_EXPONENTS[suffix];
  const power = DECIMAL_EXPONENTS[suffix];
  return power < 0 ? value / 10 ** -power : value * 10 ** power;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The local clock time of a sample: "09:05". */
export function clockTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The local day of a sample: "Nov 11". */
export function dayLabel(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
