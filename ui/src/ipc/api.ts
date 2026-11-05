import { Channel } from "@tauri-apps/api/core";
import { call } from "./client";
import type { ApiResourceInfo } from "./generated/ApiResourceInfo";
import type { ApplyResult } from "./generated/ApplyResult";
import type { ClusterEntry } from "./generated/ClusterEntry";
import type { ClusterSettings } from "./generated/ClusterSettings";
import type { ConnectionLogEntry } from "./generated/ConnectionLogEntry";
import type { ConnectionState } from "./generated/ConnectionState";
import type { InvolvedRef } from "./generated/InvolvedRef";
import type { Prefs } from "./generated/Prefs";
import type { Propagation } from "./generated/Propagation";
import type { ResourceRef } from "./generated/ResourceRef";
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
  resourceEvents: (clusterId: string, involved: InvolvedRef) =>
    call<JsonValue[]>("resource_events", { clusterId, involved }),
  uiStateGet: (key: string) => call<JsonValue | null>("ui_state_get", { key }),
  uiStateSet: (key: string, value: JsonValue) =>
    call<void>("ui_state_set", { key, value }),
};
