import { Channel } from "@tauri-apps/api/core";
import { call } from "./client";
import type { ApiResourceInfo } from "./generated/ApiResourceInfo";
import type { ApplyResult } from "./generated/ApplyResult";
import type { ClusterEntry } from "./generated/ClusterEntry";
import type { ClusterSettings } from "./generated/ClusterSettings";
import type { ConnectionLogEntry } from "./generated/ConnectionLogEntry";
import type { ConnectionState } from "./generated/ConnectionState";
import type { DataChange } from "./generated/DataChange";
import type { DrainEvent } from "./generated/DrainEvent";
import type { DrainOptions } from "./generated/DrainOptions";
import type { InvolvedRef } from "./generated/InvolvedRef";
import type { LogDownload } from "./generated/LogDownload";
import type { LogEvent } from "./generated/LogEvent";
import type { LogOptions } from "./generated/LogOptions";
import type { LogTarget } from "./generated/LogTarget";
import type { Prefs } from "./generated/Prefs";
import type { Propagation } from "./generated/Propagation";
import type { ResourceRef } from "./generated/ResourceRef";
import type { SavedKubeconfig } from "./generated/SavedKubeconfig";
import type { SecretValue } from "./generated/SecretValue";
import type { SyncWarning } from "./generated/SyncWarning";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { WatchEvent } from "./generated/WatchEvent";

export const api = {
  catalogList: () => call<ClusterEntry[]>("catalog_list"),
  catalogWarnings: () => call<SyncWarning[]>("catalog_warnings"),
  catalogAddPasted: (yaml: string) =>
    call<string[]>("catalog_add_pasted", { yaml }),
  catalogRemovePasted: (id: string) =>
    call<void>("catalog_remove_pasted", { id }),
  clusterConnect: (id: string) =>
    call<ConnectionState>("cluster_connect", { id }),
  clusterDisconnect: (id: string) => call<void>("cluster_disconnect", { id }),
  clusterState: (id: string) => call<ConnectionState>("cluster_state", { id }),
  clusterLog: (id: string) => call<ConnectionLogEntry[]>("cluster_log", { id }),
  clusterSettingsGet: (id: string) =>
    call<ClusterSettings>("cluster_settings_get", { id }),
  clusterSettingsSet: (id: string, settings: ClusterSettings) =>
    call<void>("cluster_settings_set", { id, settings }),
  hotbarGet: () => call<string[]>("hotbar_get"),
  hotbarSet: (ids: string[]) => call<void>("hotbar_set", { ids }),
  prefsGet: () => call<Prefs>("prefs_get"),
  prefsSet: (prefs: Prefs) => call<void>("prefs_set", { prefs }),
  resourcesDiscover: (clusterId: string, refresh: boolean) =>
    call<ApiResourceInfo[]>("resources_discover", { clusterId, refresh }),
  /** Returns the subscription id. Events go to `onEvent` until unsubscribed. */
  resourcesSubscribe: (
    clusterId: string,
    resource: ResourceRef,
    onEvent: (event: WatchEvent) => void,
  ) =>
    call<string>("resources_subscribe", {
      clusterId,
      resource,
      onEvent: new Channel<WatchEvent>(onEvent),
    }),
  resourcesUnsubscribe: (subscriptionId: string) =>
    call<void>("resources_unsubscribe", { subscriptionId }),
  resourceGet: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
  ) =>
    call<JsonValue>("resource_get", { clusterId, resource, namespace, name }),
  resourceGetYaml: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
  ) =>
    call<string>("resource_get_yaml", {
      clusterId,
      resource,
      namespace,
      name,
    }),
  resourceReplace: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
    yaml: string,
    force: boolean,
  ) =>
    call<JsonValue>("resource_replace", {
      clusterId,
      resource,
      namespace,
      name,
      yaml,
      force,
    }),
  resourceApply: (clusterId: string, yaml: string, defaultNamespace: string) =>
    call<ApplyResult[]>("resource_apply", {
      clusterId,
      yaml,
      defaultNamespace,
    }),
  resourceDelete: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
    propagation: Propagation,
  ) =>
    call<void>("resource_delete", {
      clusterId,
      resource,
      namespace,
      name,
      propagation,
    }),
  resourceForceFinalize: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string | null,
    name: string,
  ) =>
    call<void>("resource_force_finalize", {
      clusterId,
      resource,
      namespace,
      name,
    }),
  resourceEvents: (clusterId: string, involved: InvolvedRef) =>
    call<JsonValue[]>("resource_events", { clusterId, involved }),
  workloadScale: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string,
    name: string,
    replicas: number,
  ) =>
    call<void>("workload_scale", {
      clusterId,
      resource,
      namespace,
      name,
      replicas,
    }),
  workloadRestart: (
    clusterId: string,
    resource: ResourceRef,
    namespace: string,
    name: string,
  ) => call<void>("workload_restart", { clusterId, resource, namespace, name }),
  podEvict: (clusterId: string, namespace: string, name: string) =>
    call<void>("pod_evict", { clusterId, namespace, name }),
  cronjobTrigger: (clusterId: string, namespace: string, name: string) =>
    call<string>("cronjob_trigger", { clusterId, namespace, name }),
  cronjobSetSuspend: (
    clusterId: string,
    namespace: string,
    name: string,
    suspend: boolean,
  ) =>
    call<void>("cronjob_set_suspend", { clusterId, namespace, name, suspend }),
  podForceDelete: (
    clusterId: string,
    namespace: string,
    name: string,
    uid: string,
  ) => call<void>("pod_force_delete", { clusterId, namespace, name, uid }),
  jobSetSuspend: (
    clusterId: string,
    namespace: string,
    name: string,
    suspend: boolean,
  ) => call<void>("job_set_suspend", { clusterId, namespace, name, suspend }),
  ingressClassSetDefault: (clusterId: string, name: string) =>
    call<void>("ingress_class_set_default", { clusterId, name }),
  serviceAccountKubeconfigSave: (
    clusterId: string,
    namespace: string,
    name: string,
    destPath: string,
    expirationSeconds: number,
  ) =>
    call<SavedKubeconfig>("service_account_kubeconfig_save", {
      clusterId,
      namespace,
      name,
      destPath,
      expirationSeconds,
    }),
  nodeSetUnschedulable: (
    clusterId: string,
    name: string,
    unschedulable: boolean,
  ) => call<void>("node_set_unschedulable", { clusterId, name, unschedulable }),
  /** Returns the drain id. Events go to `onEvent`, the last being `finished`. */
  nodeDrainStart: (
    clusterId: string,
    name: string,
    options: DrainOptions,
    onEvent: (event: DrainEvent) => void,
  ) =>
    call<string>("node_drain_start", {
      clusterId,
      name,
      options,
      onEvent: new Channel<DrainEvent>(onEvent),
    }),
  nodeDrainCancel: (drainId: string) =>
    call<void>("node_drain_cancel", { drainId }),
  secretReveal: (
    clusterId: string,
    namespace: string,
    name: string,
    key: string,
  ) => call<SecretValue>("secret_reveal", { clusterId, namespace, name, key }),
  secretUpdate: (
    clusterId: string,
    namespace: string,
    name: string,
    resourceVersion: string,
    changes: DataChange[],
  ) =>
    call<void>("secret_update", {
      clusterId,
      namespace,
      name,
      resourceVersion,
      changes,
    }),
  configmapUpdate: (
    clusterId: string,
    namespace: string,
    name: string,
    resourceVersion: string,
    changes: DataChange[],
  ) =>
    call<void>("configmap_update", {
      clusterId,
      namespace,
      name,
      resourceVersion,
      changes,
    }),
  /** Returns the session id. Events go to `onEvent` until the session ends or is stopped. */
  logsStart: (
    clusterId: string,
    target: LogTarget,
    options: LogOptions,
    onEvent: (event: LogEvent) => void,
  ) =>
    call<string>("logs_start", {
      clusterId,
      target,
      options,
      onEvent: new Channel<LogEvent>(onEvent),
    }),
  logsStop: (sessionId: string) => call<void>("logs_stop", { sessionId }),
  logsDownload: (
    clusterId: string,
    target: LogTarget,
    options: LogOptions,
    destPath: string,
  ) =>
    call<LogDownload>("logs_download", {
      clusterId,
      target,
      options,
      destPath,
    }),
  /** Tells the backend that `bytes` of a session's output are stored. */
  sessionAck: (sessionId: string, bytes: number) =>
    call<void>("session_ack", { sessionId, bytes }),
  uiStateGet: (key: string) => call<JsonValue | null>("ui_state_get", { key }),
  uiStateSet: (key: string, value: JsonValue) =>
    call<void>("ui_state_set", { key, value }),
};
