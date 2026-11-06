import { type ComponentType, createElement, type ReactNode } from "react";
import { type TableColumn, useNow } from "../design/VirtualTable";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import { formatAge, type KubeObject } from "./objects";

export interface KindAction {
  id: string;
  label: string;
  danger?: boolean;
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
}

export interface DetailProps {
  clusterId: string;
  object: KubeObject;
  resource: ResourceRef;
}

export interface KindSpec {
  /** The whole set of columns for this kind, in place of the defaults. */
  columns?(resource: ApiResourceInfo): TableColumn<KubeObject>[];
  /** Row actions, shown above the Delete every kind has. */
  actions?: KindAction[];
  /** The kind's own part of the detail drawer, in place of the generic field tree. */
  detail?: ComponentType<DetailProps>;
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
