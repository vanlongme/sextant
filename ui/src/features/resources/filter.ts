import type { KubeObject } from "../../kinds/objects";

function matchesTerm(o: KubeObject, term: string): boolean {
  const labels = Object.entries(o.metadata.labels ?? {}).map(
    ([k, v]) => [k.toLowerCase(), v.toLowerCase()] as const,
  );
  const equals = term.indexOf("=");
  if (equals !== -1) {
    const key = term.slice(0, equals);
    const value = term.slice(equals + 1);
    return labels.some(([k, v]) => k === key && v === value);
  }
  return (
    o.metadata.name.toLowerCase().includes(term) ||
    (o.metadata.namespace ?? "").toLowerCase().includes(term) ||
    labels.some(([k, v]) => k.includes(term) || v.includes(term))
  );
}

/**
 * Whether an object matches a search: every term separated by spaces has to match
 * its name, namespace or a label, and `k=v` means a label with that key and value.
 * Case is ignored.
 */
export function matchesSearch(o: KubeObject, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => matchesTerm(o, term));
}
