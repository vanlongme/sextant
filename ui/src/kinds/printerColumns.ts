import type { TableColumn } from "../design/VirtualTable";
import type { KubeObject } from "./objects";
import { ageCell, ageSortValue } from "./registry";

type Step =
  | { type: "key"; key: string }
  | { type: "index"; index: number }
  | { type: "all" }
  | { type: "filter"; path: Step[]; negate: boolean; value: unknown };

function parseFilter(body: string): Step | null {
  const match = /^\?\(@(\S*?)\s*(==|!=)\s*(.+)\)$/.exec(body);
  if (!match) return null;
  const path = parsePath(match[1]);
  if (!path) return null;
  return {
    type: "filter",
    path,
    negate: match[2] === "!=",
    value: parseLiteral(match[3].trim()),
  };
}

function parseLiteral(text: string): unknown {
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if (quoted) return quoted[2];
  if (text === "true") return true;
  if (text === "false") return false;
  const number = Number(text);
  return Number.isNaN(number) ? text : number;
}

function parseBracket(body: string): Step | null {
  if (body === "" || body === "*") return { type: "all" };
  if (/^-?\d+$/.test(body)) return { type: "index", index: Number(body) };
  const quoted = /^(["'])(.*)\1$/.exec(body);
  if (quoted) return { type: "key", key: quoted[2] };
  return parseFilter(body);
}

/** The end of the bracket opened at `open`, past any quoted text inside it. */
function closingBracket(path: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < path.length; i++) {
    const c = path[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "]") {
      return i;
    }
  }
  return -1;
}

/** Splits a path into steps, or gives null when it is not one this understands. */
function parsePath(path: string): Step[] | null {
  const steps: Step[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === "[") {
      const end = closingBracket(path, i);
      const step = end === -1 ? null : parseBracket(path.slice(i + 1, end));
      if (!step) return null;
      steps.push(step);
      i = end + 1;
    } else if (path[i] === ".") {
      i += 1;
      let key = "";
      while (i < path.length && path[i] !== "." && path[i] !== "[") {
        if (path[i] === "\\" && i + 1 < path.length) i += 1;
        key += path[i];
        i += 1;
      }
      if (key === "" && path[i] !== "[" && i < path.length) return null;
      if (key !== "") steps.push({ type: "key", key });
    } else {
      return null;
    }
  }
  return steps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evaluate(start: unknown, steps: Step[]): unknown[] {
  let values: unknown[] = [start];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const value of values) {
      switch (step.type) {
        case "key":
          // A key on an array applies to each element.
          for (const item of Array.isArray(value) ? value : [value]) {
            if (isRecord(item) && step.key in item) next.push(item[step.key]);
          }
          break;
        case "index":
          if (Array.isArray(value)) {
            const at = step.index < 0 ? value.length + step.index : step.index;
            if (at >= 0 && at < value.length) next.push(value[at]);
          }
          break;
        case "all":
          if (Array.isArray(value)) next.push(...value);
          break;
        case "filter":
          for (const item of Array.isArray(value) ? value : [value]) {
            const found = evaluate(item, step.path);
            const same = found.length > 0 && found[0] === step.value;
            if (step.negate ? !same : same) next.push(item);
          }
          break;
      }
    }
    values = next;
  }
  return values;
}

function print(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(print);
  if (typeof value === "object") return [JSON.stringify(value)];
  return [String(value)];
}

/**
 * The value at a Kubernetes printer column path, as text: `.a.b`, `.a[0].b`,
 * `.a[*].b`, `.a[?(@.type=="Ready")].status`. Several values join with a comma.
 * A missing value or a path this cannot read gives an empty string.
 */
export function evaluateJsonPath(obj: unknown, path: string): string {
  const trimmed = path.trim().replace(/^\{(.*)\}$/, "$1");
  if (trimmed === "") return "";
  const steps = parsePath(trimmed);
  if (!steps) return "";
  return evaluate(obj, steps).flatMap(print).join(",");
}

/** What the API server's definition says about one printer column. */
interface PrinterColumn {
  name: string;
  type: string;
  jsonPath: string;
  priority?: number;
}

/** Sorts a number before everything else when it is missing or not a number. */
function numberSortValue(text: string): number {
  const number = text === "" ? Number.NaN : Number(text);
  return Number.isFinite(number) ? number : Number.MIN_SAFE_INTEGER;
}

function toColumn(column: PrinterColumn): TableColumn<KubeObject> {
  const value = (o: KubeObject) => evaluateJsonPath(o, column.jsonPath);
  const base = {
    id: `printer-${column.name}`,
    header: column.name,
    defaultHidden: (column.priority ?? 0) > 0,
  };
  switch (column.type) {
    case "date":
      return {
        ...base,
        width: 88,
        sortValue: (o) => ageSortValue(value(o)),
        render: (o) => ageCell(value(o)),
      };
    case "integer":
    case "number":
      return {
        ...base,
        width: 96,
        sortValue: (o) => numberSortValue(value(o)),
        render: value,
      };
    default:
      return {
        ...base,
        width: "minmax(120px, 1fr)",
        sortValue: value,
        render: value,
      };
  }
}

/** The printer columns a CustomResourceDefinition declares for one version. */
export function columnsFromCrd(
  crd: KubeObject | undefined,
  version: string,
): TableColumn<KubeObject>[] {
  const versions: unknown = crd?.spec?.versions;
  if (!Array.isArray(versions)) return [];
  const served = versions.find((v) => v?.name === version);
  const columns: unknown = served?.additionalPrinterColumns;
  return Array.isArray(columns) ? columns.map(toColumn) : [];
}
