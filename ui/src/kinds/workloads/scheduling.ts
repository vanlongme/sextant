import type { Tone } from "../../design/Badge";

type Fields = Record<string, unknown>;

const fields = (v: unknown): Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export interface Toleration {
  key?: string;
  operator?: string;
  value?: string;
  effect?: string;
  tolerationSeconds?: number;
}

export function tolerationsOf(spec: unknown): Toleration[] {
  return list(fields(spec).tolerations).map((t) => fields(t) as Toleration);
}

/** The distinct effects ("All" for an empty one), then " after ‹n›s" when all share it. */
export function tolerationSummary(tolerations: Toleration[]): string {
  const effects = [...new Set(tolerations.map((t) => t.effect || "All"))];
  const seconds = new Set(tolerations.map((t) => t.tolerationSeconds));
  const [only] = [...seconds];
  const after =
    seconds.size === 1 && typeof only === "number" ? ` after ${only}s` : "";
  return `${effects.join(", ")}${after}`;
}

/** Key, Operator, Value and Effect cells (spec H37). */
export function tolerationRow(t: Toleration): [string, string, string, string] {
  const effect = t.effect || "All";
  return [
    t.key || "—",
    t.operator || "Equal",
    t.value || "—",
    typeof t.tolerationSeconds === "number"
      ? `${effect} ${t.tolerationSeconds}s`
      : effect,
  ];
}

export interface AffinityTerm {
  type: string;
  when: string;
  match: string;
  /** The topology key, for pod terms only. */
  topology: string | null;
}

/** `key In (a, b)`, `key Exists`, `key Gt 3` and the like. */
export function expressionText(e: {
  key?: string;
  operator?: string;
  values?: string[];
}): string {
  const values = e.values ?? [];
  switch (e.operator) {
    case "In":
    case "NotIn":
      return `${e.key} ${e.operator} (${values.join(", ")})`;
    case "Gt":
    case "Lt":
      return `${e.key} ${e.operator} ${values[0] ?? ""}`;
    default:
      return `${e.key} ${e.operator}`;
  }
}

const expressions = (v: unknown) =>
  list(v).map((e) => expressionText(fields(e) as { key?: string }));

function nodeMatch(term: unknown): string {
  const t = fields(term);
  const parts = [
    ...expressions(t.matchExpressions),
    ...expressions(t.matchFields),
  ];
  return parts.length > 0 ? parts.join(" and ") : "all Nodes";
}

function podMatch(term: Fields): string {
  const selector = fields(term.labelSelector);
  const labels = Object.entries(fields(selector.matchLabels)).map(
    ([k, v]) => `${k}=${text(v)}`,
  );
  const parts = [...labels, ...expressions(selector.matchExpressions)];
  const match = parts.length > 0 ? parts.join(" and ") : "all Pods";
  const namespaces = list(term.namespaces).map(text);
  return namespaces.length > 0 ? `${match} in ${namespaces.join(", ")}` : match;
}

const REQUIRED = "requiredDuringSchedulingIgnoredDuringExecution";
const PREFERRED = "preferredDuringSchedulingIgnoredDuringExecution";
const MUST = "required during scheduling";
const weight = (w: unknown) =>
  `preferred, weight ${typeof w === "number" ? w : 0}`;

function podTerms(type: string, source: unknown): AffinityTerm[] {
  const s = fields(source);
  const term = (t: Fields, when: string): AffinityTerm => ({
    type,
    when,
    match: podMatch(t),
    topology: text(t.topologyKey) || null,
  });
  return [
    ...list(s[REQUIRED]).map((t) => term(fields(t), MUST)),
    ...list(s[PREFERRED]).map((p) =>
      term(fields(fields(p).podAffinityTerm), weight(fields(p).weight)),
    ),
  ];
}

/** One term per affinity entry, node terms first (spec H37). */
export function affinityTerms(affinity: unknown): AffinityTerm[] {
  const a = fields(affinity);
  const node = fields(a.nodeAffinity);
  return [
    ...list(fields(node[REQUIRED]).nodeSelectorTerms).map((t) => ({
      type: "Node affinity",
      when: MUST,
      match: nodeMatch(t),
      topology: null,
    })),
    ...list(node[PREFERRED]).map((p) => ({
      type: "Node affinity",
      when: weight(fields(p).weight),
      match: nodeMatch(fields(p).preference),
      topology: null,
    })),
    ...podTerms("Pod affinity", a.podAffinity),
    ...podTerms("Pod anti-affinity", a.podAntiAffinity),
  ];
}

/** The distinct term types. */
export function affinitySummary(terms: AffinityTerm[]): string {
  return [...new Set(terms.map((t) => t.type))].join(", ");
}

/** `spec.nodeSelector` as `k=v`. */
export function nodeSelectorEntries(spec: unknown): string[] {
  return Object.entries(fields(fields(spec).nodeSelector)).map(
    ([k, v]) => `${k}=${text(v)}`,
  );
}

export interface ConditionChip {
  type: string;
  tone: Tone;
  title: string;
}

/** `status.conditions` as badges: ok for True, warn for False, neutral otherwise. */
export function conditionChips(status: unknown): ConditionChip[] {
  return list(fields(status).conditions)
    .map(fields)
    .filter((c) => typeof c.type === "string")
    .map((c): ConditionChip => {
      const type = text(c.type);
      const value = text(c.status) || "Unknown";
      const reason = text(c.reason);
      return {
        type,
        tone: value === "True" ? "ok" : value === "False" ? "warn" : "neutral",
        title:
          value === "False" && reason
            ? `${type}: False (${reason})`
            : `${type}: ${value}`,
      };
    });
}
