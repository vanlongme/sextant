import type { TableColumn } from "../../design/VirtualTable";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  baseColumns,
  numberColumn,
  statusColumn,
  textColumn,
} from "../columns";
import type { KubeObject } from "../objects";
import { ageCell, ageSortValue, registerKind } from "../registry";
import { CrdDetail, EventDetail, NamespaceDetail } from "./ClusterDetails";
import {
  eventCount,
  eventLastSeen,
  eventObjectText,
  eventStatus,
  namespaceStatus,
  servedVersionNames,
} from "./cluster";

registerKind("", "namespaces", {
  columns: (info) => baseColumns(info.resource, statusColumn(namespaceStatus)),
  detail: NamespaceDetail,
});

const lastSeenColumn: TableColumn<KubeObject> = {
  id: "lastSeen",
  header: "Last seen",
  width: 96,
  sortValue: (o) => ageSortValue(eventLastSeen(o)),
  render: (o) => ageCell(eventLastSeen(o)),
};

registerKind("", "events", {
  columns: (info: ApiResourceInfo) =>
    baseColumns(
      info.resource,
      statusColumn(eventStatus, { id: "type", header: "Type" }),
      textColumn("reason", "Reason", (o) => o.reason),
      textColumn("object", "Object", eventObjectText),
      textColumn("message", "Message", (o) => o.message ?? o.note, {
        width: "minmax(200px, 3fr)",
      }),
      numberColumn("count", "Count", eventCount),
      lastSeenColumn,
    ),
  detail: EventDetail,
});

registerKind("apiextensions.k8s.io", "customresourcedefinitions", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("group", "Group", (o) => o.spec?.group),
      textColumn("kind", "Kind", (o) => o.spec?.names?.kind),
      textColumn("scope", "Scope", (o) => o.spec?.scope),
      textColumn("versions", "Versions", servedVersionNames),
    ),
  detail: CrdDetail,
});
