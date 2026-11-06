import type { ReactNode } from "react";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { ObjectLink } from "../detail/parts";

/** One row per endpoint address: address, ready, node and target. */
export function endpointRows(
  clusterId: string,
  resources: ApiResourceInfo[],
  namespace: string | undefined,
  endpoints: unknown,
): ReactNode[][] {
  const rows: ReactNode[][] = [];
  // biome-ignore lint/suspicious/noExplicitAny: endpoints vary in shape.
  for (const e of (Array.isArray(endpoints) ? endpoints : []) as any[]) {
    const ref = e?.targetRef;
    const target: ReactNode =
      ref?.kind && ref?.name ? (
        <ObjectLink
          clusterId={clusterId}
          resources={resources}
          kind={ref.kind}
          name={ref.name}
          namespace={ref.namespace ?? namespace}
        />
      ) : (
        "-"
      );
    for (const address of Array.isArray(e?.addresses) ? e.addresses : []) {
      rows.push([
        address,
        e.conditions?.ready === false ? "No" : "Yes",
        e.nodeName ?? "-",
        target,
      ]);
    }
  }
  return rows;
}
