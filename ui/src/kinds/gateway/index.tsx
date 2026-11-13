import { Badge } from "../../design";
import type { TableColumn } from "../../design/VirtualTable";
import { baseColumns, textColumn } from "../columns";
import type { KubeObject } from "../objects";
import { registerKind } from "../registry";
import {
  conditionStatus,
  gatewayAddress,
  NONE,
  routeHostnames,
  routeParents,
} from "./gateway";

const GROUP = "gateway.networking.k8s.io";

/** A condition's status in a Badge, or "—" without it. */
function conditionColumn(
  id: string,
  header: string,
  type: string,
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: 120,
    sortValue: (o) => conditionStatus(o, type)?.label ?? "",
    render: (o) => {
      const status = conditionStatus(o, type);
      return status ? <Badge tone={status.tone}>{status.label}</Badge> : NONE;
    },
  };
}

/** A text cell that is never empty: the helpers give "—" for nothing. */
function listColumn(
  id: string,
  header: string,
  get: (o: KubeObject) => string,
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: "minmax(120px, 1fr)",
    sortValue: get,
    render: (o) => <span title={get(o)}>{get(o)}</span>,
  };
}

// The Gateway API kinds stay under Custom Resources (spec E §13).
registerKind(GROUP, "gatewayclasses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("controller", "Controller", (o) => o.spec?.controllerName),
      conditionColumn("accepted", "Accepted", "Accepted"),
    ),
});

registerKind(GROUP, "gateways", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("class", "Class", (o) => o.spec?.gatewayClassName),
      listColumn("address", "Address", gatewayAddress),
      conditionColumn("programmed", "Programmed", "Programmed"),
    ),
});

registerKind(GROUP, "httproutes", {
  columns: (info) =>
    baseColumns(
      info.resource,
      listColumn("hostnames", "Hostnames", routeHostnames),
      listColumn("parents", "Parents", routeParents),
    ),
});
