import { Chips, Facts, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import { PodList } from "../workloads/PodList";
import { nodeTaints, taintText } from "./node";

function quantities(v: unknown): Record<string, string> {
  return v && typeof v === "object" ? (v as Record<string, string>) : {};
}

export function NodeDetail({ clusterId, object }: DetailProps) {
  const status = object.status ?? {};
  const info = status.nodeInfo ?? {};
  const capacity = quantities(status.capacity);
  const allocatable = quantities(status.allocatable);
  const keys = [
    ...new Set([...Object.keys(capacity), ...Object.keys(allocatable)]),
  ].sort();
  const taints = nodeTaints(object).map(taintText);
  const addresses: { type?: string; address?: string }[] = Array.isArray(
    status.addresses,
  )
    ? status.addresses
    : [];
  const name = object.metadata.name;
  return (
    <>
      <Part title="Resources">
        <SimpleTable
          testId="detail-node-resources"
          headers={["Resource", "Capacity", "Allocatable"]}
          rows={keys.map((k) => [k, capacity[k] ?? "-", allocatable[k] ?? "-"])}
          empty="No capacity reported."
        />
      </Part>
      <Part title="Taints">
        {taints.length > 0 ? <Chips values={taints} /> : <p>No taints.</p>}
      </Part>
      <Part title="Addresses">
        <SimpleTable
          headers={["Type", "Address"]}
          rows={addresses.map((a) => [a.type ?? "", a.address ?? ""])}
          empty="No addresses."
        />
      </Part>
      <Part title="System">
        <Facts
          items={[
            ["Kubelet version", info.kubeletVersion],
            ["Container runtime", info.containerRuntimeVersion],
            ["OS image", info.osImage],
            ["Kernel", info.kernelVersion],
            ["Architecture", info.architecture],
          ]}
        />
      </Part>
      <Part title="Pods">
        <PodList
          clusterId={clusterId}
          match={(p) => p.spec?.nodeName === name}
        />
      </Part>
    </>
  );
}
