import { Badge } from "../design";
import type { Tone } from "../design/Badge";
import type { TableColumn } from "../design/VirtualTable";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { KubeObject } from "./objects";
import { defaultColumns } from "./registry";

export interface StatusInfo {
  label: string;
  tone: Tone;
}

/** Name, Namespace when namespaced, the middle columns, then Age. */
export function baseColumns(
  resource: ResourceRef,
  ...middle: TableColumn<KubeObject>[]
): TableColumn<KubeObject>[] {
  const columns = defaultColumns(resource);
  const age = columns.length - 1;
  return [...columns.slice(0, age), ...middle, ...columns.slice(age)];
}

export function textColumn(
  id: string,
  header: string,
  get: (o: KubeObject) => string | undefined,
  options: { width?: string | number; defaultHidden?: boolean } = {},
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: options.width ?? "minmax(100px, 1fr)",
    defaultHidden: options.defaultHidden,
    sortValue: (o) => get(o) ?? "",
    render: (o) => {
      const value = get(o);
      return value ? <span title={value}>{value}</span> : "-";
    },
  };
}

export function numberColumn(
  id: string,
  header: string,
  get: (o: KubeObject) => number | undefined,
  options: { defaultHidden?: boolean } = {},
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: 88,
    defaultHidden: options.defaultHidden,
    sortValue: (o) => get(o) ?? 0,
    render: (o) => String(get(o) ?? 0),
  };
}

export function statusColumn(
  get: (o: KubeObject) => StatusInfo,
  options: { id?: string; header?: string } = {},
): TableColumn<KubeObject> {
  return {
    id: options.id ?? "status",
    header: options.header ?? "Status",
    width: 140,
    sortValue: (o) => get(o).label,
    render: (o) => {
      const { label, tone } = get(o);
      return <Badge tone={tone}>{label}</Badge>;
    },
  };
}
