import type { TableColumn } from "../design/VirtualTable";
import { columnCpu, columnMemory, DASH } from "../features/metrics/format";
import type { UsageItem } from "../ipc/generated/UsageItem";
import type { KubeObject } from "./objects";

export interface UsageView {
  /** Latest usage by row key (`namespace/name` for Pods, the name for nodes); null when there is none to show. */
  items: Map<string, UsageItem> | null;
  /** The cluster does not serve metrics.k8s.io: cells read "—" with a tooltip. */
  notServed: boolean;
}

export const NOT_SERVED_TIP = "metrics.k8s.io is not served";

function usageColumn(
  id: "cpu" | "memory",
  header: string,
  usage: UsageView | undefined,
  keyOf: (row: KubeObject) => string,
  read: (item: UsageItem) => number,
  format: (value: number) => string,
): TableColumn<KubeObject> {
  const value = (row: KubeObject): number | null => {
    if (!usage || usage.notServed) return null;
    const item = usage.items?.get(keyOf(row));
    if (!item) return null;
    const n = read(item);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    id,
    header,
    width: 88,
    sortValue: value,
    render: (row) => {
      const n = value(row);
      return (
        <span
          data-testid={`usage-${id}`}
          title={usage?.notServed ? NOT_SERVED_TIP : undefined}
        >
          {n === null ? DASH : format(n)}
        </span>
      );
    },
  };
}

/**
 * CPU and Memory in the `kubectl top` style (spec §11). A cell reads "—" with no
 * sample, with no provider, or when metrics.k8s.io is not served, and sorts last.
 */
export function usageColumns(
  usage: UsageView | undefined,
  keyOf: (row: KubeObject) => string,
): TableColumn<KubeObject>[] {
  return [
    usageColumn("cpu", "CPU", usage, keyOf, (i) => i.cpuCores, columnCpu),
    usageColumn(
      "memory",
      "Memory",
      usage,
      keyOf,
      (i) => i.memoryBytes,
      columnMemory,
    ),
  ];
}
