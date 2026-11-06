export interface RuleRow {
  groups: string;
  resources: string;
  names: string;
  urls: string;
  verbs: string;
}

export interface SubjectRow {
  kind: string;
  name: string;
  namespace: string;
  /** Only a ServiceAccount is an object the app can open. */
  linkable: boolean;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null,
      )
    : [];
}

/** The rules of a Role or ClusterRole, one row per rule; the core group reads `core`. */
export function ruleRows(rules: unknown): RuleRow[] {
  return records(rules).map((rule) => ({
    groups: strings(rule.apiGroups)
      .map((g) => (g === "" ? "core" : g))
      .join(", "),
    resources: strings(rule.resources).join(", "),
    names: strings(rule.resourceNames).join(", "),
    urls: strings(rule.nonResourceURLs).join(", "),
    verbs: strings(rule.verbs).join(", "),
  }));
}

export function subjectRows(subjects: unknown): SubjectRow[] {
  return records(subjects).map((s) => {
    const kind = String(s.kind ?? "");
    return {
      kind,
      name: String(s.name ?? ""),
      namespace: typeof s.namespace === "string" ? s.namespace : "",
      linkable: kind === "ServiceAccount",
    };
  });
}

/** The Subjects column: `ServiceAccount n/a, User u`. */
export function subjectsText(subjects: unknown): string {
  return subjectRows(subjects)
    .map((s) => `${s.kind} ${s.namespace ? `${s.namespace}/` : ""}${s.name}`)
    .join(", ");
}
