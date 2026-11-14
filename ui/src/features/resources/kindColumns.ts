import { useMemo } from "react";
import type { TableColumn } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { BUILTIN_GROUPS } from "../../kinds/nav";
import type { KubeObject } from "../../kinds/objects";
import { columnsFromCrd } from "../../kinds/printerColumns";
import { defaultColumns, kindSpec } from "../../kinds/registry";
import type { UsageView } from "../../kinds/usageColumns";
import { findResource, useResourceList } from "../../stores/resources";
import { useListUsage } from "../metrics/useListUsage";

/**
 * The definition of a custom resource, kept up to date. It is undefined for
 * built-in kinds, without a kind, and while or when definitions cannot be listed.
 */
export function useCustomResourceDefinition(
  clusterId: string,
  info: ApiResourceInfo | undefined,
  resources: ApiResourceInfo[],
): KubeObject | undefined {
  const crds = findResource(
    resources,
    "apiextensions.k8s.io",
    "customresourcedefinitions",
  );
  const watchable =
    info !== undefined &&
    !BUILTIN_GROUPS.has(info.resource.group) &&
    crds?.canList === true &&
    crds.canWatch;
  const list = useResourceList(clusterId, watchable ? crds.resource : null);
  if (!info) return undefined;
  const name = `${info.resource.plural}.${info.resource.group}`;
  return list.items.find((o) => o.metadata.name === name);
}

/** The table columns of a kind: its own, its CRD's printer columns, or the defaults. */
export function kindColumns(
  info: ApiResourceInfo,
  crd: KubeObject | undefined,
  usage: UsageView | undefined,
): TableColumn<KubeObject>[] {
  const { resource } = info;
  const registered = kindSpec(resource.group, resource.plural)?.columns;
  if (registered) return registered(info, usage);
  const printer = columnsFromCrd(crd, resource.version);
  if (printer.length === 0) return defaultColumns(resource);
  return [
    ...defaultColumns(resource).filter((c) => c.id !== "age"),
    ...printer,
  ];
}

/**
 * The columns of any kind, for a linked object's Summary (spec H29, H52). Pods and Nodes
 * add CPU and Memory for the object's namespace.
 */
export function useKindColumns(
  clusterId: string,
  info: ApiResourceInfo | undefined,
  resources: ApiResourceInfo[],
  namespace: string | null,
): TableColumn<KubeObject>[] {
  const crd = useCustomResourceDefinition(clusterId, info, resources);
  const namespaces = useMemo(() => (namespace ? [namespace] : []), [namespace]);
  const usage = useListUsage(clusterId, info?.resource ?? null, namespaces);
  return useMemo(
    () => (info ? kindColumns(info, crd, usage) : []),
    [info, crd, usage],
  );
}
