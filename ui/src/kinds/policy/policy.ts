import type { KubeObject } from "../objects";
import { selectorText } from "../selectors";

type Obj = Pick<KubeObject, "metadata"> & Partial<KubeObject>;

const UNKNOWN = "<unknown>";

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects vary in shape.
function list<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export interface HpaMetric {
  name: string;
  on: string;
  current: string;
  target: string;
}

// biome-ignore lint/suspicious/noExplicitAny: metric blocks vary by type.
type Block = any;

function present(v: unknown): string | undefined {
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

function percentOrValue(block: Block): string | undefined {
  if (typeof block?.averageUtilization === "number") {
    return `${block.averageUtilization}%`;
  }
  return present(block?.averageValue);
}

/** The block of a metric entry that carries its data, by the entry's type. */
function metricBlock(m: Block): Block {
  switch (m?.type) {
    case "Resource":
      return m.resource;
    case "ContainerResource":
      return m.containerResource;
    case "Pods":
      return m.pods;
    case "Object":
      return m.object;
    case "External":
      return m.external;
    default:
      return undefined;
  }
}

function metricName(m: Block): string {
  const block = metricBlock(m);
  return block?.name ?? block?.metric?.name ?? "";
}

function metricValue(m: Block, side: "target" | "current"): string {
  const block = metricBlock(m);
  const v: Block = block?.[side];
  let text: string | undefined;
  switch (m?.type) {
    case "Resource":
    case "ContainerResource":
      text = percentOrValue(v);
      break;
    case "Pods":
      text = present(v?.averageValue);
      break;
    case "Object":
      text = present(v?.value) ?? present(v?.averageValue);
      break;
    case "External": {
      const avg = present(v?.averageValue);
      text = present(v?.value) ?? (avg ? `${avg} (avg)` : undefined);
      break;
    }
  }
  return text ?? UNKNOWN;
}

function metricOn(m: Block): string {
  const block = metricBlock(m);
  switch (m?.type) {
    case "ContainerResource":
      return `container ${block?.container ?? ""}`;
    case "Object":
      return `${block?.describedObject?.kind ?? ""}/${block?.describedObject?.name ?? ""}`;
    case "External":
      return "External";
    default:
      return "Pods";
  }
}

/** Each spec metric paired with the current metric of the same type and name. */
export function hpaMetrics(o: Obj): HpaMetric[] {
  const specs = list(o.spec?.metrics);
  if (specs.length === 0) {
    const target = o.spec?.targetCPUUtilizationPercentage;
    if (typeof target !== "number") return [];
    const current = o.status?.currentCPUUtilizationPercentage;
    return [
      {
        name: "cpu",
        on: "Pods",
        current: typeof current === "number" ? `${current}%` : UNKNOWN,
        target: `${target}%`,
      },
    ];
  }
  const currents = list(o.status?.currentMetrics);
  return specs.map((m) => {
    const name = metricName(m);
    const found = currents.find(
      (c) =>
        c?.type === m?.type &&
        metricName(c) === name &&
        (m.type !== "ContainerResource" ||
          metricBlock(c)?.container === metricBlock(m)?.container),
    );
    return {
      name,
      on: metricOn(m),
      current: found ? metricValue(found, "current") : UNKNOWN,
      target: metricValue(m, "target"),
    };
  });
}

/** The Targets column, as kubectl prints it. */
export function hpaTargetsText(o: Obj): string {
  const rows = hpaMetrics(o);
  if (rows.length === 0) return "<none>";
  return rows.map((r) => `${r.name}: ${r.current}/${r.target}`).join(", ");
}

export interface QuotaRow {
  resource: string;
  used: string;
  hard: string;
}

export function quotaRows(o: Obj): QuotaRow[] {
  const hard: Record<string, string> = o.status?.hard ?? {};
  const used: Record<string, string> = o.status?.used ?? {};
  return Object.keys(hard)
    .sort()
    .map((resource) => ({
      resource,
      used: String(used[resource] ?? "0"),
      hard: String(hard[resource]),
    }));
}

/** Quota columns as kubectl splits them: `limits.*` apart from the rest. */
export function quotaText(o: Obj): { request: string; limit: string } {
  const request: string[] = [];
  const limit: string[] = [];
  for (const r of quotaRows(o)) {
    const text = `${r.resource}: ${r.used}/${r.hard}`;
    (r.resource.startsWith("limits.") ? limit : request).push(text);
  }
  return { request: request.join(", "), limit: limit.join(", ") };
}

export interface LimitRow {
  type: string;
  resource: string;
  min: string;
  max: string;
  defaultRequest: string;
  defaultLimit: string;
  ratio: string;
}

export function limitRows(o: Obj): LimitRow[] {
  const rows: LimitRow[] = [];
  for (const item of list(o.spec?.limits)) {
    const get = (field: string, resource: string): string =>
      String(item?.[field]?.[resource] ?? "");
    const resources = new Set<string>();
    for (const field of [
      "min",
      "max",
      "default",
      "defaultRequest",
      "maxLimitRequestRatio",
    ]) {
      for (const key of Object.keys(item?.[field] ?? {})) resources.add(key);
    }
    for (const resource of [...resources].sort()) {
      rows.push({
        type: String(item?.type ?? ""),
        resource,
        min: get("min", resource),
        max: get("max", resource),
        defaultRequest: get("defaultRequest", resource),
        defaultLimit: get("default", resource),
        ratio: get("maxLimitRequestRatio", resource),
      });
    }
  }
  return rows;
}

export interface WebhookRule {
  operations: string;
  apiGroups: string;
  apiVersions: string;
  resources: string;
  scope: string;
}

export interface WebhookRow {
  name: string;
  client: string;
  failurePolicy: string;
  matchPolicy: string;
  sideEffects: string;
  timeout: string;
  namespaceSelector: string[];
  objectSelector: string[];
  rules: WebhookRule[];
}

function joined(v: unknown): string {
  return list<string>(v).join(", ");
}

function webhookClient(config: Block): string {
  if (config?.service) {
    const { namespace, name, port, path } = config.service;
    return `${namespace ?? ""}/${name ?? ""}${port ? `:${port}` : ""}${path ?? ""}`;
  }
  return config?.url ?? "";
}

export function webhookRows(o: Obj): WebhookRow[] {
  return list(o.webhooks).map((w) => ({
    name: String(w?.name ?? ""),
    client: webhookClient(w?.clientConfig),
    failurePolicy: String(w?.failurePolicy ?? ""),
    matchPolicy: String(w?.matchPolicy ?? ""),
    sideEffects: String(w?.sideEffects ?? ""),
    timeout: w?.timeoutSeconds ? `${w.timeoutSeconds}s` : "",
    namespaceSelector: selectorText(w?.namespaceSelector),
    objectSelector: selectorText(w?.objectSelector),
    rules: list(w?.rules).map((r) => ({
      operations: joined(r?.operations),
      apiGroups: joined(r?.apiGroups),
      apiVersions: joined(r?.apiVersions),
      resources: joined(r?.resources),
      scope: String(r?.scope ?? "*"),
    })),
  }));
}
