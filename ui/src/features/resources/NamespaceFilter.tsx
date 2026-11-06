import { ChevronDown } from "lucide-react";
import { Button, CheckMenu } from "../../design";

/** The UI state key of a cluster's namespace filter: a list, empty for All. */
export function namespaceFilterKey(clusterId: string): string {
  return `namespaces:${clusterId}`;
}

function label(selected: string[]): string {
  if (selected.length === 0) return "All namespaces";
  return selected.length === 1 ? selected[0] : `${selected.length} namespaces`;
}

/** Chooses the namespaces to show. Choosing none means All. */
export function NamespaceFilter(props: {
  /** The namespaces that can be chosen, which may not include all of `selected`. */
  namespaces: string[];
  selected: string[];
  onChange(selected: string[]): void;
}) {
  const { selected, onChange } = props;
  const options = [...new Set([...props.namespaces, ...selected])].sort();
  return (
    <CheckMenu
      trigger={
        <Button size="sm" aria-haspopup="menu" data-testid="namespace-filter">
          {label(selected)}
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      }
      items={[
        {
          id: "all",
          label: "All namespaces",
          checked: selected.length === 0,
          testId: "namespace-all",
          onToggle: () => onChange([]),
        },
        ...options.map((ns) => ({
          id: `ns-${ns}`,
          label: ns,
          checked: selected.includes(ns),
          testId: `namespace-option-${ns}`,
          onToggle: () =>
            onChange(
              selected.includes(ns)
                ? selected.filter((s) => s !== ns)
                : [...selected, ns],
            ),
        })),
      ]}
    />
  );
}
