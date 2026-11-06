import { Facts, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import {
  backendText,
  ingressAddress,
  ingressClass,
  ingressRoutes,
} from "./network";

export function IngressDetail({ object }: DetailProps) {
  const spec = object.spec ?? {};
  const tls: { hosts?: string[]; secretName?: string }[] = Array.isArray(
    spec.tls,
  )
    ? spec.tls
    : [];
  const defaultBackend = backendText(spec.defaultBackend);
  return (
    <>
      <Part title="Ingress">
        <Facts
          items={[
            ["Class", ingressClass(object)],
            ["Address", ingressAddress(object)],
            ["Default backend", defaultBackend],
          ]}
        />
      </Part>
      <Part title="Rules">
        <SimpleTable
          testId="detail-ingress-rules"
          headers={["Host", "Path", "Path type", "Backend"]}
          rows={ingressRoutes(object).map((r) => [
            r.host,
            r.path,
            r.pathType || "-",
            r.backend,
          ])}
          empty="No rules."
        />
      </Part>
      <Part title="TLS">
        <SimpleTable
          testId="detail-ingress-tls"
          headers={["Hosts", "Secret"]}
          rows={tls.map((t) => [
            (Array.isArray(t.hosts) ? t.hosts : []).join(", ") || "*",
            t.secretName ?? "-",
          ])}
          empty="No TLS."
        />
      </Part>
    </>
  );
}
