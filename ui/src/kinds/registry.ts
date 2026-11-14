import type { LucideIcon } from "lucide-react";
import { type ComponentType, createElement, type ReactNode } from "react";
import { type TableColumn, useNow } from "../design/VirtualTable";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import { formatAge, type KubeObject } from "./objects";
import type { UsageView } from "./usageColumns";
import type { VolumeItem } from "./workloads/volumes";

export interface KindAction {
  id: string;
  label: string;
  /** Drawn at 16 px in menus and on the drawer's header buttons. */
  icon: LucideIcon;
  danger?: boolean;
  /** Also shown as an icon button in the drawer header. */
  top?: boolean;
  /** `"end"` places the action after Force finalize, just before Delete. */
  placement?: "end";
  /** The access the action needs; it is disabled without it. */
  requires?: "update" | "patch" | "delete";
  visible?(o: KubeObject): boolean;
  run(ctx: ActionContext, o: KubeObject): void | Promise<void>;
}

export interface ActionContext {
  clusterId: string;
  resource: ResourceRef;
  navigate(to: string): void;
  confirm(opts: {
    title: string;
    body: ReactNode;
    confirmLabel: string;
    danger?: boolean;
  }): Promise<boolean>;
  openEditor(o: KubeObject): void;
  /** Shows a dialog of the kind's own; `render` gets the function that closes it. */
  dialog(render: (close: () => void) => ReactNode): void;
}

export interface DetailProps {
  clusterId: string;
  object: KubeObject;
  resource: ResourceRef;
  resources: ApiResourceInfo[];
}

/** The props of a delete dialog: the generic one, or a kind's own (`deleteDialog`). */
export interface DeleteDialogProps {
  clusterId: string;
  resource: ResourceRef;
  objects: KubeObject[];
  onCancel(): void;
  /** Called after trying them all, with the keys of the objects that are gone. */
  onDeleted(keys: string[]): void;
}

/** One stat of the drawer's Summary (spec H29). */
export interface SummaryStat {
  id: string;
  label: string;
  value: ReactNode;
  title?: string;
}

/** One fact of the drawer's Relations after the generic ones (spec H30). */
export interface RelationFact {
  label: string;
  value: ReactNode;
}

/** The Pod spec a kind runs, for its Volumes (spec H36, H39, H40). */
export interface PodSpecSource {
  spec: unknown;
  /** The Pod's own name, so an ephemeral volume links to its claim; null for templates. */
  podName: string | null;
  /** A StatefulSet's claim templates, listed after the volumes. */
  claimTemplates?: VolumeItem[];
}

export interface KindSpec {
  /**
   * The whole set of columns for this kind, in place of the defaults. `usage` is the
   * latest metrics-server usage, for the kinds that show CPU and Memory.
   */
  columns?(
    resource: ApiResourceInfo,
    usage?: UsageView,
  ): TableColumn<KubeObject>[];
  /** Row actions, shown above the Delete every kind has. */
  actions?: KindAction[];
  /** The kind's own part of the detail drawer, in place of the generic field tree. */
  detail?: ComponentType<DetailProps>;
  /**
   * A dialog of the kind's own in place of the generic Delete dialog, for one object
   * or many. The row menu, the drawer and bulk delete all open it.
   */
  deleteDialog?: ComponentType<DeleteDialogProps>;
  /**
   * The drawer's Summary in place of the columns. `cell(id)` renders that column's cell
   * for the object, or returns null when the kind has no such column.
   */
  summary?(
    object: KubeObject,
    cell: (columnId: string) => ReactNode | null,
    props: DetailProps,
  ): SummaryStat[];
  /** Facts added to Relations after Namespace, Controlled by and Owners. */
  relations?(props: DetailProps): RelationFact[];
  /** The Pod spec behind the object; it adds Volumes and "Controlled by: None". */
  podSpec?(object: KubeObject): PodSpecSource;
  /** True when the kind's detail shows `status.conditions` itself. */
  ownConditions?: boolean;
}

const specs = new Map<string, KindSpec>();

function specKey(group: string, plural: string): string {
  return `${group}/${plural}`;
}

export function registerKind(
  group: string,
  plural: string,
  spec: KindSpec,
): void {
  specs.set(specKey(group, plural), spec);
}

export function kindSpec(group: string, plural: string): KindSpec | undefined {
  return specs.get(specKey(group, plural));
}

/** Every registered kind, for tests that walk them all. */
export function registeredKinds(): {
  group: string;
  plural: string;
  spec: KindSpec;
}[] {
  return [...specs.entries()].map(([key, spec]) => {
    const slash = key.indexOf("/");
    return { group: key.slice(0, slash), plural: key.slice(slash + 1), spec };
  });
}

function Age(props: { from: string | undefined }): string {
  return formatAge(props.from, useNow());
}

/** A cell showing how long ago `from` was, which keeps itself up to date. */
export function ageCell(from: string | undefined): ReactNode {
  return createElement(Age, { from });
}

/** Sorts ages, smallest first. Something with no time sorts as the oldest. */
export function ageSortValue(from: string | undefined): number {
  const time = from ? Date.parse(from) : Number.NaN;
  return Number.isNaN(time) ? 0 : -time;
}

function text(value: string): ReactNode {
  return createElement("span", { title: value }, value);
}

/** Name, Namespace when namespaced, and Age. */
export function defaultColumns(
  resource: ResourceRef,
): TableColumn<KubeObject>[] {
  const name: TableColumn<KubeObject> = {
    id: "name",
    header: "Name",
    width: "minmax(200px, 2fr)",
    sortValue: (o) => o.metadata.name,
    render: (o) => text(o.metadata.name),
  };
  const namespace: TableColumn<KubeObject> = {
    id: "namespace",
    header: "Namespace",
    width: "minmax(120px, 1fr)",
    sortValue: (o) => o.metadata.namespace ?? "",
    render: (o) => text(o.metadata.namespace ?? ""),
  };
  const age: TableColumn<KubeObject> = {
    id: "age",
    header: "Age",
    width: 88,
    sortValue: (o) => ageSortValue(o.metadata.creationTimestamp),
    render: (o) => ageCell(o.metadata.creationTimestamp),
  };
  return resource.namespaced ? [name, namespace, age] : [name, age];
}
