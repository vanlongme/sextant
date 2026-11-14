import { CalendarClock, Container as ContainerIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { Badge } from "../../design";
import { ForwardButton } from "../../features/portForward/ForwardButton";
import { PortForwardDialog } from "../../features/portForward/PortForwardDialog";
import { isTcp } from "../../features/portForward/ports";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  Chips,
  ExpandRow,
  FactList,
  FactRow,
  Item,
  ItemList,
  ObjectLink,
  Part,
  SimpleTable,
  SubRow,
} from "../detail/parts";
import partStyles from "../detail/parts.module.css";
import { formatCreated, type KubeObject } from "../objects";
import type { DetailProps, RelationFact, SummaryStat } from "../registry";
import { type ContainerInfo, containersOf, type EnvRef } from "./pod";
import {
  affinitySummary,
  affinityTerms,
  conditionChips,
  nodeSelectorEntries,
  tolerationRow,
  tolerationSummary,
  tolerationsOf,
} from "./scheduling";
import { wrapPath } from "./volumes";
import styles from "./workloads.module.css";

/**
 * The Pod's Summary (spec H34). A stat whose column the list lacks, such as CPU on a
 * cluster without metrics columns, is left out.
 */
export function podSummaryStats(
  object: KubeObject,
  cell: (columnId: string) => ReactNode | null,
  props: DetailProps,
): SummaryStat[] {
  const created = object.metadata.creationTimestamp;
  const ip = cell("ip");
  const stats: SummaryStat[] = [
    { id: "status", label: "Status", value: cell("status") },
    { id: "ready", label: "Ready", value: cell("ready") },
    { id: "restarts", label: "Restarts", value: cell("restarts") },
    {
      id: "age",
      label: "Age",
      value: cell("age"),
      title: created ? `Created ${formatCreated(created)}` : undefined,
    },
    { id: "qos", label: "QoS class", value: cell("qos") },
    {
      id: "ip",
      label: "Pod IP",
      value: ip === null ? null : <span className={partStyles.mono}>{ip}</span>,
    },
    { id: "cpu", label: "CPU", value: cell("cpu") },
    { id: "memory", label: "Memory", value: cell("memory") },
  ];
  const priority = object.spec?.priorityClassName;
  if (typeof priority === "string" && priority !== "") {
    stats.push({
      id: "priority",
      label: "Priority class",
      value: (
        <ObjectLink
          clusterId={props.clusterId}
          resources={props.resources}
          kind="PriorityClass"
          name={priority}
          apiVersion="scheduling.k8s.io/v1"
          label={priority}
        />
      ),
    });
  }
  return stats.filter((s) => s.value !== null);
}

function serviceAccountFact(props: DetailProps, spec: unknown): RelationFact {
  const raw =
    spec !== null && typeof spec === "object"
      ? (spec as { serviceAccountName?: unknown }).serviceAccountName
      : undefined;
  const name = typeof raw === "string" && raw !== "" ? raw : "default";
  return {
    label: "Service account",
    value: (
      <ObjectLink
        clusterId={props.clusterId}
        resources={props.resources}
        kind="ServiceAccount"
        name={name}
        namespace={props.object.metadata.namespace}
        apiVersion="v1"
        label={name}
      />
    ),
  };
}

/** The Relations a kind that runs a Pod spec adds: its service account (spec H39). */
export function serviceAccountRelations(
  read: (object: KubeObject) => unknown,
): (props: DetailProps) => RelationFact[] {
  return (props) => [serviceAccountFact(props, read(props.object))];
}

/** The Pod's Relations after Namespace and Controlled by (spec H35). */
export function podRelations(props: DetailProps): RelationFact[] {
  const node = props.object.spec?.nodeName;
  return [
    {
      label: "Node",
      value:
        typeof node === "string" && node !== "" ? (
          <ObjectLink
            clusterId={props.clusterId}
            resources={props.resources}
            kind="Node"
            name={node}
            apiVersion="v1"
            label={node}
          />
        ) : (
          <span className={partStyles.muted}>Not scheduled</span>
        ),
    },
    serviceAccountFact(props, props.object.spec),
  ];
}

function None() {
  return <span className={partStyles.muted}>None</span>;
}

/** One fact on its own, between expand rows. */
function Fact(props: { label: string; testId?: string; children: ReactNode }) {
  return (
    <FactList>
      <FactRow label={props.label} testId={props.testId}>
        {props.children}
      </FactRow>
    </FactList>
  );
}

/** Node selector, tolerations, affinities and conditions (spec H37). */
function Scheduling({ object }: { object: KubeObject }) {
  const selector = nodeSelectorEntries(object.spec);
  const tolerations = tolerationsOf(object.spec);
  const terms = affinityTerms(object.spec?.affinity);
  const conditions = conditionChips(object.status);
  return (
    <Part title="Scheduling" icon={CalendarClock} testId="detail-scheduling">
      <Fact label="Node selector">
        {selector.length > 0 ? <Chips values={selector} /> : <None />}
      </Fact>
      {tolerations.length > 0 ? (
        <ExpandRow
          label="Tolerations"
          count={tolerations.length}
          summary={tolerationSummary(tolerations)}
          testId="detail-tolerations"
        >
          <SimpleTable
            headers={["Key", "Operator", "Value", "Effect"]}
            rows={tolerations.map((t) => {
              const [key, operator, value, effect] = tolerationRow(t);
              return [
                <span key="key" className={partStyles.mono}>
                  {key}
                </span>,
                operator,
                value,
                effect,
              ];
            })}
            empty=""
          />
        </ExpandRow>
      ) : (
        <Fact label="Tolerations">
          <None />
        </Fact>
      )}
      {terms.length > 0 ? (
        <ExpandRow
          label="Affinities"
          count={terms.length}
          summary={affinitySummary(terms)}
          testId="detail-affinities"
        >
          <ul className={styles.terms}>
            {terms.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: terms have no identity
              <li key={i} className={styles.term}>
                <span>
                  {t.type} <span className={partStyles.muted}>{t.when}</span>
                </span>
                <span>
                  <span className={partStyles.muted}>Match</span>{" "}
                  <span className={partStyles.mono}>{t.match}</span>
                </span>
                {t.topology !== null ? (
                  <span>
                    <span className={partStyles.muted}>Topology</span>{" "}
                    <span className={partStyles.mono}>{t.topology}</span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </ExpandRow>
      ) : (
        <Fact label="Affinities">
          <None />
        </Fact>
      )}
      <Fact label="Conditions" testId="detail-conditions">
        {conditions.length > 0 ? (
          <ul className={partStyles.chips}>
            {conditions.map((c) => (
              <li key={c.type} title={c.title}>
                <Badge tone={c.tone}>{c.type}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <None />
        )}
      </Fact>
    </Part>
  );
}

/** One line per port; a regular container's TCP ports get Forward (spec B4). */
function PortLines(props: {
  info: ContainerInfo;
  onForward?(port: number): void;
}) {
  const { info, onForward } = props;
  return (
    <ul className={styles.ports} data-testid={`pod-ports-${info.name}`}>
      {info.portSpecs.map((spec, index) => {
        const port = spec.containerPort;
        const text = info.ports[index];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: ports may repeat
          <li key={`${index}:${text}`} className={styles.portLine}>
            <span>
              <span className={styles.portText}>{text}</span>
              {spec.name ? (
                <>
                  {" "}
                  <span className={styles.portName}>{spec.name}</span>
                </>
              ) : null}
            </span>
            {onForward && port !== null && isTcp(spec.protocol) ? (
              <ForwardButton
                port={port}
                testId={`pod-port-forward-${info.name}-${port}`}
                onClick={() => onForward(port)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

interface LinkScope {
  clusterId: string;
  resources: ApiResourceInfo[];
  namespace?: string;
}

/** `NAME ← Secret creds / password`; the reference is named, never resolved. */
function EnvRefLine(props: { envRef: EnvRef; scope: LinkScope }) {
  const r = props.envRef;
  const name = <span className={partStyles.mono}>{r.name}</span>;
  if (r.from === "key") {
    return (
      <span>
        {name}
        <span className={partStyles.muted}> ← {r.kind} </span>
        <ObjectLink
          clusterId={props.scope.clusterId}
          resources={props.scope.resources}
          kind={r.kind}
          name={r.source}
          namespace={props.scope.namespace}
          apiVersion="v1"
          label={r.source}
        />
        <span className={partStyles.mono}> / {r.key}</span>
      </span>
    );
  }
  if (r.from === "field") {
    return (
      <span>
        {name}
        <span className={partStyles.muted}> ← field </span>
        <span className={partStyles.mono}>{r.path}</span>
      </span>
    );
  }
  return (
    <span>
      {name}
      <span className={partStyles.muted}> ← resource </span>
      <span className={partStyles.mono}>{r.resource}</span>
    </span>
  );
}

/** One container (spec H38). Init containers get no `onForward`: they end once they have run. */
function ContainerItem(props: {
  info: ContainerInfo;
  scope: LinkScope;
  onForward?(port: number): void;
}) {
  const { info, scope } = props;
  return (
    <Item
      testId={`detail-container-${info.name}`}
      head={
        <>
          <span className={styles.name} title={info.name}>
            {info.name}
          </span>
          <Badge tone={info.state.tone}>{info.state.label}</Badge>
          <Badge tone={info.ready ? "ok" : "warn"}>
            {info.ready ? "Ready" : "Not ready"}
          </Badge>
          {info.init ? <Badge tone="neutral">Init</Badge> : null}
        </>
      }
    >
      {info.image ? (
        <SubRow label="Image">
          <span className={partStyles.mono} title={info.image}>
            {wrapPath(info.image)}
          </span>
        </SubRow>
      ) : null}
      {info.portSpecs.length > 0 ? (
        <SubRow label="Ports">
          <PortLines
            info={info}
            onForward={info.init ? undefined : props.onForward}
          />
        </SubRow>
      ) : null}
      {info.requests ? (
        <SubRow label="Requests">
          <span>{info.requests}</span>
        </SubRow>
      ) : null}
      {info.limits ? (
        <SubRow label="Limits">
          <span>{info.limits}</span>
        </SubRow>
      ) : null}
      {info.env.length > 0 ? (
        <SubRow label="Env">
          {info.env.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: variables may repeat
            <span key={`${i}:${line}`} className={partStyles.mono}>
              {line}
            </span>
          ))}
        </SubRow>
      ) : null}
      {info.envFrom.length > 0 ? (
        <SubRow label="Env from">
          {info.envFrom.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sources may repeat
            <span key={i}>
              <span className={partStyles.muted}>{s.kind}</span>{" "}
              <ObjectLink
                clusterId={scope.clusterId}
                resources={scope.resources}
                kind={s.kind}
                name={s.name}
                namespace={scope.namespace}
                apiVersion="v1"
                label={s.name}
              />
              {s.prefix ? ` prefix ${s.prefix}` : null}
            </span>
          ))}
        </SubRow>
      ) : null}
      {info.envRefs.length > 0 ? (
        <SubRow label="Env refs">
          {info.envRefs.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: references may repeat
            <EnvRefLine key={i} envRef={r} scope={scope} />
          ))}
        </SubRow>
      ) : null}
      {info.probes.length > 0 ? (
        <SubRow label="Probes">
          {info.probes.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </SubRow>
      ) : null}
      {info.restarts > 0 ? (
        <SubRow label="Restarts">
          <span>{info.restarts}</span>
        </SubRow>
      ) : null}
    </Item>
  );
}

/**
 * The Pod's own sections: Scheduling and Containers (spec H33). Summary, Relations,
 * Volumes and Metadata come from the drawer's Overview.
 */
export function PodDetail({
  clusterId,
  object,
  resources,
}: DetailProps): ReactElement {
  // The detail view has no ActionContext, so it keeps the dialog itself (spec §5.2).
  const [forwarding, setForwarding] = useState<number | null>(null);
  const containers = containersOf(object);
  const scope: LinkScope = {
    clusterId,
    resources,
    namespace: object.metadata.namespace,
  };
  return (
    <>
      <Scheduling object={object} />
      {containers.length > 0 ? (
        <Part
          title="Containers"
          icon={ContainerIcon}
          count={containers.length}
          testId="detail-containers"
        >
          <ItemList>
            {containers.map((c) => (
              <ContainerItem
                key={c.name}
                info={c}
                scope={scope}
                onForward={setForwarding}
              />
            ))}
          </ItemList>
        </Part>
      ) : null}
      {forwarding !== null ? (
        <PortForwardDialog
          clusterId={clusterId}
          kind="pod"
          object={object}
          port={forwarding}
          close={() => setForwarding(null)}
        />
      ) : null}
    </>
  );
}
