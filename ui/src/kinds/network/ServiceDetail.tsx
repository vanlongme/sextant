import { useState } from "react";
import { ErrorNotice, Spinner } from "../../design";
import { ForwardButton } from "../../features/portForward/ForwardButton";
import { PortForwardDialog } from "../../features/portForward/PortForwardDialog";
import { isTcp } from "../../features/portForward/ports";
import { useResourceList } from "../../stores/resources";
import { Chips, Facts, Part, SimpleTable } from "../detail/parts";
import { ENDPOINT_SLICES } from "../refs";
import type { DetailProps } from "../registry";
import { selectorText } from "../selectors";
import { endpointRows } from "./endpointRows";
import { serviceExternalIp } from "./network";

function ServiceEndpoints(props: {
  clusterId: string;
  resources: DetailProps["resources"];
  name: string;
  namespace: string | undefined;
}) {
  const { clusterId, resources, name, namespace } = props;
  const list = useResourceList(clusterId, ENDPOINT_SLICES);
  if (list.status === "forbidden" || list.status === "notServed") {
    return (
      <ErrorNotice
        title="Endpoints cannot be listed"
        message={list.message ?? "Endpoint slices are not available."}
      />
    );
  }
  if (list.loading) return <Spinner label="Loading endpoints" />;

  const slices = list.items.filter(
    (s) =>
      s.metadata.namespace === namespace &&
      s.metadata.labels?.["kubernetes.io/service-name"] === name,
  );
  const rows = slices.flatMap((slice) =>
    endpointRows(clusterId, resources, namespace, slice.endpoints),
  );
  return (
    <SimpleTable
      testId="detail-service-endpoints"
      headers={["Address", "Ready", "Node", "Target"]}
      rows={rows}
      empty="No endpoints."
    />
  );
}

export function ServiceDetail({ clusterId, object, resources }: DetailProps) {
  // The detail view has no ActionContext, so it keeps the dialog itself (spec §5.2).
  const [forwarding, setForwarding] = useState<number | null>(null);
  const spec = object.spec ?? {};
  const selector = Object.entries(spec.selector ?? {}).map(
    ([k, v]) => `${k}=${v}`,
  );
  const ports: {
    name?: string;
    port?: number;
    targetPort?: number | string;
    nodePort?: number;
    protocol?: string;
  }[] = Array.isArray(spec.ports) ? spec.ports : [];
  const clusterIps: string[] = Array.isArray(spec.clusterIPs)
    ? spec.clusterIPs
    : spec.clusterIP
      ? [spec.clusterIP]
      : [];
  return (
    <>
      <Part title="Service">
        <Facts
          items={[
            ["Type", spec.type ?? "ClusterIP"],
            ["Cluster IP", clusterIps.join(", ")],
            ["External IP", serviceExternalIp(object)],
            ["Session affinity", spec.sessionAffinity],
          ]}
        />
      </Part>
      {selector.length > 0 ? (
        <Part title="Selector">
          <Chips values={selectorText({ matchLabels: spec.selector })} />
        </Part>
      ) : null}
      <Part title="Ports">
        <SimpleTable
          testId="detail-service-ports"
          headers={["Name", "Port", "Target port", "Node port", "Protocol", ""]}
          rows={ports.map((p) => {
            const port =
              typeof p.port === "number" && isTcp(p.protocol) ? p.port : null;
            return [
              p.name ?? "-",
              String(p.port ?? ""),
              String(p.targetPort ?? p.port ?? ""),
              p.nodePort ? String(p.nodePort) : "-",
              p.protocol ?? "TCP",
              port === null ? null : (
                <ForwardButton
                  key="forward"
                  port={port}
                  testId={`service-port-forward-${port}`}
                  onClick={() => setForwarding(port)}
                />
              ),
            ];
          })}
          empty="No ports."
        />
      </Part>
      <Part title="Endpoints">
        <ServiceEndpoints
          clusterId={clusterId}
          resources={resources}
          name={object.metadata.name}
          namespace={object.metadata.namespace}
        />
      </Part>
      {forwarding !== null ? (
        <PortForwardDialog
          clusterId={clusterId}
          kind="service"
          object={object}
          port={forwarding}
          close={() => setForwarding(null)}
        />
      ) : null}
    </>
  );
}
