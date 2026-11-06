import { Chips, Facts, ObjectLink, Part } from "../detail/parts";
import type { DetailProps } from "../registry";
import { type ContainerInfo, containersOf, podSummary } from "./pod";
import styles from "./workloads.module.css";

function Lines(props: { title: string; values: string[] }) {
  if (props.values.length === 0) return null;
  return (
    <div>
      <div className={styles.muted}>{props.title}</div>
      <ul className={styles.list}>
        {props.values.map((value, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: values may repeat
          <li key={`${index}:${value}`}>{value}</li>
        ))}
      </ul>
    </div>
  );
}

function Container({ info }: { info: ContainerInfo }) {
  return (
    <div className={styles.container}>
      <Part title={info.name} testId={`detail-container-${info.name}`}>
        <Facts
          items={[
            ["Image", info.image],
            ["State", info.state],
            ["Ready", info.ready ? "Yes" : "No"],
            ["Restarts", String(info.restarts)],
          ]}
        />
        {info.ports.length > 0 ? <Chips values={info.ports} /> : null}
        <Lines title="Environment" values={info.env} />
        <Lines title="Mounts" values={info.mounts} />
        <Lines title="Probes" values={info.probes} />
        <Lines title="Requests" values={info.requests} />
        <Lines title="Limits" values={info.limits} />
      </Part>
    </div>
  );
}

export function PodDetail({ clusterId, object, resources }: DetailProps) {
  const summary = podSummary(object);
  const node = object.spec?.nodeName;
  const containers = containersOf(object);
  const inits = containers.filter((c) => c.init);
  const regular = containers.filter((c) => !c.init);
  return (
    <>
      <Part title="Pod">
        <Facts
          items={[
            ["Status", summary.status],
            ["Phase", object.status?.phase],
            [
              "Node",
              node ? (
                <ObjectLink
                  key="node"
                  clusterId={clusterId}
                  resources={resources}
                  kind="Node"
                  name={node}
                  apiVersion="v1"
                />
              ) : undefined,
            ],
            ["Pod IP", object.status?.podIP],
            ["Host IP", object.status?.hostIP],
            ["QoS", object.status?.qosClass],
            ["Service account", object.spec?.serviceAccountName],
          ]}
        />
      </Part>
      {inits.length > 0 ? (
        <Part title="Init containers">
          {inits.map((c) => (
            <Container key={c.name} info={c} />
          ))}
        </Part>
      ) : null}
      {regular.length > 0 ? (
        <Part title="Containers">
          {regular.map((c) => (
            <Container key={c.name} info={c} />
          ))}
        </Part>
      ) : null}
    </>
  );
}
