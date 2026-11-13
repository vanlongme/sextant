import { Maximize2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "../../design/Button";
import { StatusDot } from "../../design/StatusDot";
import styles from "./DrawerMap.module.css";
import { useFocusMap } from "./focusMap";
import { MapCanvas } from "./MapCanvas";
import { Connections, STATUS_TONE } from "./MapDetails";
import {
  goneText,
  MapEmpty,
  MapError,
  MapLoading,
  MapNote,
  tooManyText,
} from "./MapStates";
import { missingText, nodeOf, statusLine, tooMany } from "./model";
import { mapPath, objectMapPath } from "./paths";

/** The kinds the drawer offers a Resource map tab for, by API group (spec E §11). */
const MAP_KINDS: Readonly<Record<string, string>> = {
  Pod: "",
  Deployment: "apps",
  ReplicaSet: "apps",
  StatefulSet: "apps",
  DaemonSet: "apps",
  Job: "batch",
  CronJob: "batch",
  Service: "",
  Ingress: "networking.k8s.io",
  Gateway: "gateway.networking.k8s.io",
  HTTPRoute: "gateway.networking.k8s.io",
};

/** True when the drawer of this kind has a Resource map tab. */
export function hasDrawerMap(resource: { kind: string; group: string }) {
  return (
    Object.hasOwn(MAP_KINDS, resource.kind) &&
    MAP_KINDS[resource.kind] === resource.group
  );
}

/** The drawer's Resource map tab (spec E §11): the object map at 2 hops, compact. */
export function DrawerMap({
  clusterId,
  kind,
  namespace,
  name,
}: {
  clusterId: string;
  kind: string;
  namespace: string;
  name: string;
}) {
  const navigate = useNavigate();
  const focusId = `${kind}/${namespace}/${name}`;
  const { graph, model, ids, gone } = useFocusMap(clusterId, focusId, 2);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = selected !== null && ids.includes(selected) ? selected : null;
  const snapshot = graph.snapshot;

  let body: React.ReactNode;
  if (graph.error !== null) {
    body = <MapError message={graph.error} onRetry={graph.retry} />;
  } else if (!model) {
    body = <MapLoading />;
  } else if (gone) {
    body = (
      <MapEmpty text={goneText(kind, name)}>
        <Button
          size="sm"
          data-testid="map-to-cluster"
          onClick={() => navigate(mapPath(clusterId))}
        >
          Back to the cluster map
        </Button>
      </MapEmpty>
    );
  } else if (tooMany(ids)) {
    body = <MapNote text={tooManyText(ids.length)} />;
  } else {
    const node = shown === null ? null : nodeOf(model, shown);
    body = (
      <>
        {snapshot && snapshot.missing.length > 0 ? (
          <MapNote text={missingText(snapshot.missing)} />
        ) : null}
        <MapCanvas
          model={model}
          ids={ids}
          layout="grouped"
          page="object"
          flow="v"
          focusId={focusId}
          memoryKey={`${clusterId}|drawer|${focusId}`}
          selected={shown}
          onSelect={setSelected}
          compact
        />
        {node !== null ? (
          <section
            className={styles.details}
            data-testid="drawer-map-details"
            aria-label={`${node.kind} ${node.name}`}
          >
            <span className={styles.kind}>{node.kind}</span>
            <span className={styles.name}>{node.name}</span>
            <span className={styles.status}>
              <StatusDot
                tone={STATUS_TONE[node.status]}
                label={statusLine(node)}
              />
              {statusLine(node)}
            </span>
            <Connections model={model} id={node.id} onSelect={setSelected} />
          </section>
        ) : null}
      </>
    );
  }

  return (
    <section className={styles.tab} data-testid="drawer-map">
      <div className={styles.head}>
        <p className={styles.line}>
          Owner references, selectors and mounts, 2 hops out.
        </p>
        <Link
          className={styles.open}
          to={objectMapPath(clusterId, focusId)}
          aria-label={`Open the full map for this ${kind.toLowerCase()}`}
          title={`Open the full map for this ${kind.toLowerCase()}`}
          data-testid="drawer-map-open"
        >
          <Maximize2 size={14} aria-hidden="true" />
        </Link>
      </div>
      {body}
    </section>
  );
}
