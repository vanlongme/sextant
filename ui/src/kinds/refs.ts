import type { ResourceRef } from "../ipc/generated/ResourceRef";

export const PODS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
export const JOBS: ResourceRef = {
  group: "batch",
  version: "v1",
  plural: "jobs",
  kind: "Job",
  namespaced: true,
};
export const CRONJOBS: ResourceRef = {
  group: "batch",
  version: "v1",
  plural: "cronjobs",
  kind: "CronJob",
  namespaced: true,
};
export const DEPLOYMENTS: ResourceRef = {
  group: "apps",
  version: "v1",
  plural: "deployments",
  kind: "Deployment",
  namespaced: true,
};
export const CONFIGMAPS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "configmaps",
  kind: "ConfigMap",
  namespaced: true,
};
export const SECRETS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "secrets",
  kind: "Secret",
  namespaced: true,
};
export const ENDPOINT_SLICES: ResourceRef = {
  group: "discovery.k8s.io",
  version: "v1",
  plural: "endpointslices",
  kind: "EndpointSlice",
  namespaced: true,
};
export const RESOURCE_QUOTAS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "resourcequotas",
  kind: "ResourceQuota",
  namespaced: true,
};
export const NODES: ResourceRef = {
  group: "",
  version: "v1",
  plural: "nodes",
  kind: "Node",
  namespaced: false,
};
