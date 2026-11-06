import { baseColumns, statusColumn, textColumn } from "../columns";
import { registerKind } from "../registry";
import { selectorText } from "../selectors";
import { EndpointSliceDetail } from "./EndpointSliceDetail";
import { IngressClassDetail } from "./IngressClassDetail";
import { IngressDetail } from "./IngressDetail";
import { NetworkPolicyDetail } from "./NetworkPolicyDetail";
import {
  ingressAddress,
  ingressClass,
  ingressClassParameters,
  ingressHosts,
  ingressPorts,
  isDefaultIngressClass,
  serviceExternalIp,
  servicePorts,
  serviceStatus,
  sliceEndpoints,
  slicePorts,
} from "./network";
import { ServiceDetail } from "./ServiceDetail";

registerKind("", "services", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("type", "Type", (o) => o.spec?.type ?? "ClusterIP"),
      textColumn("clusterIp", "Cluster IP", (o) => o.spec?.clusterIP),
      textColumn("externalIp", "External IP", serviceExternalIp),
      textColumn("ports", "Ports", servicePorts),
      statusColumn(serviceStatus),
    ),
  detail: ServiceDetail,
});

registerKind("discovery.k8s.io", "endpointslices", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("addressType", "Address type", (o) => o.addressType),
      textColumn("ports", "Ports", slicePorts),
      textColumn("endpoints", "Endpoints", sliceEndpoints),
    ),
  detail: EndpointSliceDetail,
});

registerKind("networking.k8s.io", "ingresses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("class", "Class", ingressClass),
      textColumn("hosts", "Hosts", ingressHosts),
      textColumn("address", "Address", ingressAddress),
      textColumn("ports", "Ports", ingressPorts),
    ),
  detail: IngressDetail,
});

registerKind("networking.k8s.io", "ingressclasses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("controller", "Controller", (o) => o.spec?.controller),
      textColumn("parameters", "Parameters", ingressClassParameters),
      textColumn("default", "Default", (o) =>
        isDefaultIngressClass(o) ? "Yes" : "-",
      ),
    ),
  detail: IngressClassDetail,
});

registerKind("networking.k8s.io", "networkpolicies", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("podSelector", "Pod selector", (o) => {
        const text = selectorText(o.spec?.podSelector).join(", ");
        return text || "<none>";
      }),
      textColumn("policyTypes", "Policy types", (o) =>
        Array.isArray(o.spec?.policyTypes)
          ? o.spec.policyTypes.join(", ")
          : undefined,
      ),
    ),
  detail: NetworkPolicyDetail,
});
