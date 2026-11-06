import { Facts, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import { endpointRows } from "./endpointRows";
import { slicePorts } from "./network";

export function EndpointSliceDetail({
  clusterId,
  object,
  resources,
}: DetailProps) {
  const rows = endpointRows(
    clusterId,
    resources,
    object.metadata.namespace,
    object.endpoints,
  );
  return (
    <>
      <Part title="Endpoint slice">
        <Facts
          items={[
            ["Address type", object.addressType],
            ["Ports", slicePorts(object)],
          ]}
        />
      </Part>
      <Part title="Endpoints">
        <SimpleTable
          testId="detail-slice-endpoints"
          headers={["Address", "Ready", "Node", "Target"]}
          rows={rows}
          empty="No endpoints."
        />
      </Part>
    </>
  );
}
