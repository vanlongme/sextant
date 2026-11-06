import { ErrorNotice, Spinner } from "../../design";
import { FieldTree } from "../../features/details/FieldTree";
import { useResourceList } from "../../stores/resources";
import { Facts, ObjectLink, Part, SimpleTable } from "../detail/parts";
import { quotaRows } from "../policy/policy";
import { RESOURCE_QUOTAS } from "../refs";
import type { DetailProps } from "../registry";
import {
  crdVersions,
  eventCount,
  eventLastSeen,
  namespaceStatus,
  preferredVersion,
  printerColumnRows,
} from "./cluster";

function NamespaceQuotas(props: { clusterId: string; namespace: string }) {
  const list = useResourceList(props.clusterId, RESOURCE_QUOTAS);
  if (list.status === "forbidden" || list.status === "notServed") {
    return (
      <ErrorNotice
        title="Quotas cannot be listed"
        message={list.message ?? "Resource quotas are not available."}
      />
    );
  }
  if (list.loading) return <Spinner label="Loading quotas" />;
  const rows = list.items
    .filter((q) => q.metadata.namespace === props.namespace)
    .flatMap((q) =>
      quotaRows(q).map((r) => [q.metadata.name, r.resource, r.used, r.hard]),
    );
  return (
    <SimpleTable
      testId="detail-quota-summary"
      headers={["Quota", "Resource", "Used", "Hard"]}
      rows={rows}
      empty="No quotas."
    />
  );
}

export function NamespaceDetail({ clusterId, object }: DetailProps) {
  return (
    <>
      <Part title="Namespace">
        <Facts items={[["Status", namespaceStatus(object).label]]} />
      </Part>
      <Part title="Quotas">
        <NamespaceQuotas
          clusterId={clusterId}
          namespace={object.metadata.name}
        />
      </Part>
    </>
  );
}

export function EventDetail({ clusterId, object, resources }: DetailProps) {
  const target = object.involvedObject ?? object.regarding;
  const source = object.source ?? {};
  const sourceText =
    [source.component ?? object.reportingController, source.host]
      .filter(Boolean)
      .join(" on ") || undefined;
  const link = target?.name ? (
    <ObjectLink
      clusterId={clusterId}
      resources={resources}
      kind={String(target.kind ?? "")}
      name={String(target.name)}
      namespace={target.namespace ?? object.metadata.namespace}
      apiVersion={target.apiVersion}
    />
  ) : undefined;
  return (
    <Part title="Event">
      <Facts
        items={[
          ["Type", object.type],
          ["Reason", object.reason],
          ["Object", link],
          ["Count", String(eventCount(object))],
          ["Source", sourceText],
          ["Message", object.message ?? object.note],
          ["First seen", object.firstTimestamp ?? object.eventTime],
          ["Last seen", eventLastSeen(object)],
        ]}
      />
    </Part>
  );
}

export function CrdDetail({ object }: DetailProps) {
  const spec = object.spec ?? {};
  const names = spec.names ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : undefined);
  const preferred = preferredVersion(object);
  const schema = preferred?.schema?.openAPIV3Schema;
  return (
    <>
      <Part title="Custom resource definition">
        <Facts
          items={[
            ["Group", spec.group],
            ["Scope", spec.scope],
            ["Kind", names.kind],
            ["Plural", names.plural],
            ["Singular", names.singular],
            ["Short names", list(names.shortNames)],
            ["Categories", list(names.categories)],
          ]}
        />
      </Part>
      <Part title="Versions">
        <SimpleTable
          testId="detail-crd-versions"
          headers={["Name", "Served", "Storage"]}
          rows={crdVersions(object).map((v) => [
            v.name,
            v.served === false ? "No" : "Yes",
            v.storage ? "Yes" : "No",
          ])}
          empty="No versions."
        />
      </Part>
      <Part title={`Printer columns${preferred ? ` (${preferred.name})` : ""}`}>
        <SimpleTable
          testId="detail-crd-columns"
          headers={["Name", "Type", "JSON path", "Priority", "Description"]}
          rows={printerColumnRows(preferred).map((c) => [
            c.name,
            c.type,
            c.jsonPath,
            c.priority,
            c.description,
          ])}
          empty="No printer columns."
        />
      </Part>
      <Part title="Schema" testId="detail-crd-schema">
        {schema ? <FieldTree value={schema} /> : <p>No schema.</p>}
      </Part>
    </>
  );
}
