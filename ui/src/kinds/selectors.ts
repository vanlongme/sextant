export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/**
 * Whether labels satisfy a Kubernetes label selector. A missing selector
 * matches nothing; an empty one matches everything.
 */
export function matchesSelector(
  labels: Record<string, string> | undefined,
  selector: LabelSelector | undefined,
): boolean {
  if (!selector) return false;
  const have = labels ?? {};
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (have[key] !== value) return false;
  }
  for (const expr of selector.matchExpressions ?? []) {
    const present = Object.hasOwn(have, expr.key);
    const values = expr.values ?? [];
    switch (expr.operator) {
      case "In":
        if (!present || !values.includes(have[expr.key] as string))
          return false;
        break;
      case "NotIn":
        if (present && values.includes(have[expr.key] as string)) return false;
        break;
      case "Exists":
        if (!present) return false;
        break;
      case "DoesNotExist":
        if (present) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** A selector as kubectl prints it, one entry per requirement. */
export function selectorText(selector: LabelSelector | undefined): string[] {
  if (!selector) return [];
  const out = Object.entries(selector.matchLabels ?? {}).map(
    ([k, v]) => `${k}=${v}`,
  );
  for (const expr of selector.matchExpressions ?? []) {
    const values = (expr.values ?? []).join(", ");
    switch (expr.operator) {
      case "In":
        out.push(`${expr.key} in (${values})`);
        break;
      case "NotIn":
        out.push(`${expr.key} notin (${values})`);
        break;
      case "Exists":
        out.push(expr.key);
        break;
      case "DoesNotExist":
        out.push(`!${expr.key}`);
        break;
      default:
        out.push(`${expr.key} ${expr.operator} (${values})`);
    }
  }
  return out;
}
