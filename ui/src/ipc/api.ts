import { call } from "./client";
import type { ClusterEntry } from "./generated/ClusterEntry";
import type { ClusterSettings } from "./generated/ClusterSettings";
import type { ConnectionLogEntry } from "./generated/ConnectionLogEntry";
import type { ConnectionState } from "./generated/ConnectionState";
import type { Prefs } from "./generated/Prefs";
import type { SyncWarning } from "./generated/SyncWarning";

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
};
