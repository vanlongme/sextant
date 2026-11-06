import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";

export interface NavResource {
  type: "resource";
  label: string;
  /** The API group; "" is the core group. */
  group: string;
  plural: string;
}

export interface NavSection {
  id: string;
  label: string;
  /** A first "Overview" entry that links to `/cluster/:id/<overview>`. */
  overview?: string;
  items: NavResource[];
}

function r(label: string, group: string, plural: string): NavResource {
  return { type: "resource", label, group, plural };
}

/**
 * The sidebar sections of F4, in order. Overview is the cluster home route and not
 * a resource. The Workloads Overview entry is in the sidebar, but its page is
 * a placeholder until the overview screens (F17). Helm (Charts, Releases) and Port
 * Forwarding arrive in later phases (Helm in Phase 4, Port Forwarding in Phase 5),
 * so they are left out for now. Custom Resources starts with Definitions; the
 * entries for each CRD are added by `customResourceGroups`.
 */
export const NAV_SECTIONS: NavSection[] = [
  { id: "nodes", label: "Nodes", items: [r("Nodes", "", "nodes")] },
  {
    id: "workloads",
    label: "Workloads",
    overview: "workloads",
    items: [
      r("Pods", "", "pods"),
      r("Deployments", "apps", "deployments"),
      r("DaemonSets", "apps", "daemonsets"),
      r("StatefulSets", "apps", "statefulsets"),
      r("ReplicaSets", "apps", "replicasets"),
      r("Jobs", "batch", "jobs"),
      r("CronJobs", "batch", "cronjobs"),
    ],
  },
  {
    id: "config",
    label: "Config",
    items: [
      r("ConfigMaps", "", "configmaps"),
      r("Secrets", "", "secrets"),
      r("ResourceQuotas", "", "resourcequotas"),
      r("LimitRanges", "", "limitranges"),
      r("HorizontalPodAutoscalers", "autoscaling", "horizontalpodautoscalers"),
      r("PodDisruptionBudgets", "policy", "poddisruptionbudgets"),
      r("PriorityClasses", "scheduling.k8s.io", "priorityclasses"),
      r("RuntimeClasses", "node.k8s.io", "runtimeclasses"),
      r("Leases", "coordination.k8s.io", "leases"),
      r(
        "MutatingWebhookConfigurations",
        "admissionregistration.k8s.io",
        "mutatingwebhookconfigurations",
      ),
      r(
        "ValidatingWebhookConfigurations",
        "admissionregistration.k8s.io",
        "validatingwebhookconfigurations",
      ),
    ],
  },
  {
    id: "network",
    label: "Network",
    items: [
      r("Services", "", "services"),
      r("EndpointSlices", "discovery.k8s.io", "endpointslices"),
      r("Ingresses", "networking.k8s.io", "ingresses"),
      r("IngressClasses", "networking.k8s.io", "ingressclasses"),
      r("NetworkPolicies", "networking.k8s.io", "networkpolicies"),
    ],
  },
  {
    id: "storage",
    label: "Storage",
    items: [
      r("PersistentVolumeClaims", "", "persistentvolumeclaims"),
      r("PersistentVolumes", "", "persistentvolumes"),
      r("StorageClasses", "storage.k8s.io", "storageclasses"),
    ],
  },
  {
    id: "namespaces",
    label: "Namespaces",
    items: [r("Namespaces", "", "namespaces")],
  },
  { id: "events", label: "Events", items: [r("Events", "", "events")] },
  {
    id: "access",
    label: "Access Control",
    items: [
      r("ServiceAccounts", "", "serviceaccounts"),
      r("ClusterRoles", "rbac.authorization.k8s.io", "clusterroles"),
      r("Roles", "rbac.authorization.k8s.io", "roles"),
      r(
        "ClusterRoleBindings",
        "rbac.authorization.k8s.io",
        "clusterrolebindings",
      ),
      r("RoleBindings", "rbac.authorization.k8s.io", "rolebindings"),
    ],
  },
  {
    id: "custom",
    label: "Custom Resources",
    items: [
      r("Definitions", "apiextensions.k8s.io", "customresourcedefinitions"),
    ],
  },
];

/** API groups that ship with Kubernetes. Resources in any other group are custom. */
export const BUILTIN_GROUPS: ReadonlySet<string> = new Set([
  "",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "apps",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "autoscaling",
  "batch",
  "certificates.k8s.io",
  "coordination.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "networking.k8s.io",
  "node.k8s.io",
  "policy",
  "rbac.authorization.k8s.io",
  "resource.k8s.io",
  "scheduling.k8s.io",
  "storage.k8s.io",
]);

export interface CrdGroup {
  group: string;
  items: { label: string; plural: string }[];
}

function listable(resources: ApiResourceInfo[]): Set<string> {
  const out = new Set<string>();
  for (const info of resources) {
    if (info.canList) out.add(`${info.resource.group}/${info.resource.plural}`);
  }
  return out;
}

/** Removes the items that are not served or not listable, then empty sections. */
export function visibleSections(resources: ApiResourceInfo[]): NavSection[] {
  const ok = listable(resources);
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((i) => ok.has(`${i.group}/${i.plural}`)),
  })).filter((section) => section.items.length > 0);
}

/** Listable custom resources grouped by API group, with groups and items sorted. */
export function customResourceGroups(resources: ApiResourceInfo[]): CrdGroup[] {
  const groups = new Map<string, CrdGroup>();
  for (const info of resources) {
    const { group, plural, kind } = info.resource;
    if (BUILTIN_GROUPS.has(group) || !info.canList) continue;
    const entry = groups.get(group) ?? { group, items: [] };
    entry.items.push({ label: kind, plural });
    groups.set(group, entry);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    a.group.localeCompare(b.group),
  );
  for (const g of sorted) {
    g.items.sort((a, b) => a.label.localeCompare(b.label));
  }
  return sorted;
}

/** The URL segment for an API group: the core group is "core". */
export function groupSegment(group: string): string {
  return group === "" ? "core" : group;
}

/** The API group for a URL segment. */
export function groupFromSegment(segment: string): string {
  return segment === "core" ? "" : segment;
}

export function resourcePath(
  clusterId: string,
  group: string,
  plural: string,
): string {
  return `/cluster/${encodeURIComponent(clusterId)}/r/${encodeURIComponent(groupSegment(group))}/${encodeURIComponent(plural)}`;
}
