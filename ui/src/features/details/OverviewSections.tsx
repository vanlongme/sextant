import { Activity, HardDrive, Link as LinkIcon, ListTree } from "lucide-react";
import type { ReactElement } from "react";
import { Badge, type TableColumn } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  FactList,
  FactRow,
  Item,
  ItemList,
  ObjectLink,
  Part,
  StatGrid,
  SubRow,
} from "../../kinds/detail/parts";
import partStyles from "../../kinds/detail/parts.module.css";
import type { KubeObject } from "../../kinds/objects";
import {
  type DetailProps,
  kindSpec,
  type RelationFact,
  type SummaryStat,
} from "../../kinds/registry";
import {
  type SourcePart,
  type VolumeItem,
  volumeRows,
} from "../../kinds/workloads/volumes";
import { ConditionsSection } from "./ConditionsSection";
import { FieldTree } from "./FieldTree";
import { MetadataSection } from "./MetadataSection";

/** Columns the drawer shows in its own sections already. */
export const SUMMARY_SKIP: ReadonlySet<string> = new Set([
  "name",
  "namespace",
  "age",
  "actions",
]);

/** The default Summary: the kind's columns, in table order, each showing its cell. */
export function summaryStats(
  columns: readonly TableColumn<KubeObject>[],
  object: KubeObject,
): SummaryStat[] {
  return columns
    .filter((c) => !SUMMARY_SKIP.has(c.id))
    .map((c) => ({ id: c.id, label: c.header, value: c.render(object) }));
}

export interface OverviewProps {
  clusterId: string;
  resource: ResourceRef;
  object: KubeObject;
  resources: ApiResourceInfo[];
  /** The columns of the object's kind, for the Summary. */
  columns: readonly TableColumn<KubeObject>[];
}

const detailProps = (p: OverviewProps): DetailProps => ({
  clusterId: p.clusterId,
  object: p.object,
  resource: p.resource,
  resources: p.resources,
});

const specOf = (p: OverviewProps) =>
  kindSpec(p.resource.group, p.resource.plural);

function SummarySection(props: OverviewProps) {
  const { object, columns } = props;
  const spec = specOf(props);
  const cell = (id: string) =>
    columns.find((c) => c.id === id)?.render(object) ?? null;
  const stats = spec?.summary
    ? spec.summary(object, cell, detailProps(props))
    : summaryStats(columns, object);
  if (stats.length === 0) return null;
  return (
    <Part title="Summary" icon={Activity} testId="detail-summary">
      <StatGrid stats={stats} />
    </Part>
  );
}

function RelationsSection(props: OverviewProps) {
  const { clusterId, object, resources } = props;
  const spec = specOf(props);
  const namespace = object.metadata.namespace;
  const owners = object.metadata.ownerReferences ?? [];
  const controller = owners.find((o) => o.controller === true);
  const others = owners.filter((o) => o !== controller);
  const ownerLink = (o: (typeof owners)[number]) => (
    <ObjectLink
      clusterId={clusterId}
      resources={resources}
      kind={o.kind}
      name={o.name}
      namespace={namespace}
      apiVersion={o.apiVersion}
      label={o.name}
      testId="detail-owner-link"
    />
  );
  const facts: RelationFact[] = [];
  if (namespace) {
    facts.push({
      label: "Namespace",
      value: (
        <ObjectLink
          clusterId={clusterId}
          resources={resources}
          kind="Namespace"
          name={namespace}
          apiVersion="v1"
          label={namespace}
        />
      ),
    });
  }
  if (controller) {
    facts.push({
      label: "Controlled by",
      value: (
        <>
          <span className={partStyles.muted}>{controller.kind}</span>{" "}
          {ownerLink(controller)}
        </>
      ),
    });
  } else if (spec?.podSpec) {
    facts.push({
      label: "Controlled by",
      value: <span className={partStyles.muted}>None</span>,
    });
  }
  if (others.length > 0) {
    facts.push({
      label: "Owners",
      value: (
        <span className={partStyles.subLines}>
          {others.map((o) => (
            <span key={o.uid}>
              {o.kind} {ownerLink(o)}
            </span>
          ))}
        </span>
      ),
    });
  }
  facts.push(...(spec?.relations?.(detailProps(props)) ?? []));
  if (facts.length === 0) return null;
  return (
    <Part title="Relations" icon={LinkIcon} testId="detail-relations">
      <FactList>
        {facts.map((f) => (
          <FactRow key={f.label} label={f.label}>
            {f.value}
          </FactRow>
        ))}
      </FactList>
    </Part>
  );
}

function SourceBit(props: {
  part: SourcePart;
  clusterId: string;
  resources: ApiResourceInfo[];
}) {
  const { part } = props;
  if (part.link) {
    return (
      <ObjectLink
        clusterId={props.clusterId}
        resources={props.resources}
        kind={part.link.kind}
        name={part.link.name}
        namespace={part.link.namespace ?? undefined}
        label={part.text}
      />
    );
  }
  const className = [
    part.mono ? partStyles.mono : "",
    part.muted ? partStyles.muted : "",
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={className || undefined}>{part.text}</span>;
}

function VolumeEntry(props: {
  item: VolumeItem;
  clusterId: string;
  resources: ApiResourceInfo[];
}) {
  const { item } = props;
  return (
    <Item
      testId={`detail-volume-${item.name}`}
      head={
        <>
          <span className={partStyles.mono}>{item.name}</span>
          <Badge tone="neutral">{item.type}</Badge>
        </>
      }
    >
      {item.source.length > 0 ? (
        <SubRow label="Source">
          {item.source.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: source lines have no identity
            <span key={i}>
              {line.map((part, j) => (
                <SourceBit
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity
                  key={j}
                  part={part}
                  clusterId={props.clusterId}
                  resources={props.resources}
                />
              ))}
            </span>
          ))}
        </SubRow>
      ) : null}
      {item.mounted.length > 0 ? (
        <SubRow label="Mounted">
          {item.mounted.map((m) => (
            <span key={m.text} className={partStyles.mono} title={m.title}>
              {m.text}
            </span>
          ))}
        </SubRow>
      ) : null}
    </Item>
  );
}

function VolumesSection(props: OverviewProps) {
  const source = specOf(props)?.podSpec?.(props.object);
  if (!source) return null;
  const namespace = props.object.metadata.namespace ?? null;
  const items = [
    ...volumeRows(source.spec, namespace, source.podName),
    ...(source.claimTemplates ?? []),
  ];
  if (items.length === 0) return null;
  return (
    <Part
      title="Volumes"
      icon={HardDrive}
      count={items.length}
      testId="detail-volumes"
    >
      <ItemList>
        {items.map((item) => (
          <VolumeEntry
            key={item.name}
            item={item}
            clusterId={props.clusterId}
            resources={props.resources}
          />
        ))}
      </ItemList>
    </Part>
  );
}

/**
 * The Overview tab of every kind, in the order of spec H28: Summary, Relations,
 * Volumes, Conditions, the kind's own parts or Fields, then Metadata.
 */
export function OverviewSections(props: OverviewProps): ReactElement {
  const { clusterId, resource, object, resources } = props;
  const spec = specOf(props);
  const Detail = spec?.detail;
  const { metadata: _metadata, ...rest } = object;
  return (
    <>
      <SummarySection {...props} />
      <RelationsSection {...props} />
      <VolumesSection {...props} />
      {spec?.ownConditions ? null : (
        <ConditionsSection status={object.status} />
      )}
      {Detail ? (
        <Detail
          clusterId={clusterId}
          object={object}
          resource={resource}
          resources={resources}
        />
      ) : (
        <Part title="Fields" icon={ListTree}>
          <FieldTree value={rest} />
        </Part>
      )}
      <MetadataSection
        object={object}
        clusterId={clusterId}
        resources={resources}
      />
    </>
  );
}
