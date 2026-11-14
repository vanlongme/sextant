import type { KubeObject } from "../objects";

/** One piece of a Volumes source line. */
export interface SourcePart {
  text: string;
  mono?: boolean;
  muted?: boolean;
  /** Drawn as an ObjectLink labelled `text`. */
  link?: { kind: string; name: string; namespace: string | null };
}

/** One "Mounted" line: `‹container› → ‹path›`, with the original path as its title. */
export interface MountLine {
  text: string;
  title: string;
}

/** One Volumes item (spec H36, H40). */
export interface VolumeItem {
  name: string;
  /** The badge. */
  type: string;
  /** Source lines; empty for a type with none. */
  source: SourcePart[][];
  mounted: MountLine[];
}

type Fields = Record<string, unknown>;

const fields = (v: unknown): Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** A zero-width space after each slash, so a long path may wrap there. */
export function wrapPath(path: string): string {
  return path.replaceAll("/", "/​");
}

/** The mounts of `volume` in init containers, then containers. */
export function mountLines(spec: unknown, volume: string): MountLine[] {
  const s = fields(spec);
  const lines: MountLine[] = [];
  for (const c of [...list(s.initContainers), ...list(s.containers)]) {
    const container = fields(c);
    for (const m of list(container.volumeMounts)) {
      const mount = fields(m);
      if (mount.name !== volume) continue;
      const path = text(mount.mountPath);
      let line = `${text(container.name)} → ${wrapPath(path)}`;
      if (mount.readOnly === true) line += ", ro";
      if (text(mount.subPath) !== "")
        line += `, subPath ${text(mount.subPath)}`;
      lines.push({ text: line, title: path });
    }
  }
  return lines;
}

const BADGES: Record<string, string> = {
  configMap: "ConfigMap",
  secret: "Secret",
  persistentVolumeClaim: "PersistentVolumeClaim",
  emptyDir: "EmptyDir",
  projected: "Projected",
  hostPath: "HostPath",
  downwardAPI: "DownwardAPI",
  csi: "CSI",
  nfs: "NFS",
  ephemeral: "Ephemeral",
  image: "Image",
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const fieldPaths = (source: Fields) =>
  list(source.items)
    .map((i) => text(fields(fields(i).fieldRef).fieldPath))
    .filter((p) => p !== "")
    .join(", ");

function linked(
  kind: string,
  name: string,
  namespace: string | null,
): SourcePart {
  return { text: name, link: { kind, name, namespace } };
}

function projectedLine(source: Fields, namespace: string | null): SourcePart[] {
  const [key] = Object.keys(source);
  const value = fields(source[key]);
  switch (key) {
    case "serviceAccountToken": {
      const seconds =
        typeof value.expirationSeconds === "number"
          ? value.expirationSeconds
          : 3600;
      return [
        { text: "ServiceAccount token ", muted: true },
        { text: `${seconds}s` },
      ];
    }
    case "configMap":
      return [
        { text: "ConfigMap ", muted: true },
        linked("ConfigMap", text(value.name), namespace),
      ];
    case "secret":
      return [
        { text: "Secret ", muted: true },
        linked("Secret", text(value.name), namespace),
      ];
    case "downwardAPI":
      return [
        { text: "DownwardAPI ", muted: true },
        { text: fieldPaths(value), mono: true },
      ];
    case "clusterTrustBundle":
      return [
        { text: "ClusterTrustBundle ", muted: true },
        { text: text(value.name) || text(value.signerName), mono: true },
      ];
    default:
      return [{ text: capital(key ?? ""), muted: true }];
  }
}

function describeVolume(
  volume: Fields,
  namespace: string | null,
  podName: string | null,
): { type: string; source: SourcePart[][] } {
  const key = Object.keys(volume).find((k) => k !== "name") ?? "";
  const value = fields(volume[key]);
  const type = BADGES[key] ?? capital(key);
  switch (key) {
    case "configMap":
      return {
        type,
        source: [[linked("ConfigMap", text(value.name), namespace)]],
      };
    case "secret":
      return {
        type,
        source: [[linked("Secret", text(value.secretName), namespace)]],
      };
    case "persistentVolumeClaim": {
      const line = [
        linked("PersistentVolumeClaim", text(value.claimName), namespace),
      ];
      if (value.readOnly === true) line.push({ text: ", ro" });
      return { type, source: [line] };
    }
    case "emptyDir": {
      const where = value.medium === "Memory" ? "Memory" : "Node disk";
      const limit = text(value.sizeLimit);
      return {
        type,
        source: [[{ text: limit ? `${where}, ${limit} limit` : where }]],
      };
    }
    case "projected":
      return {
        type,
        source: list(value.sources).map((s) =>
          projectedLine(fields(s), namespace),
        ),
      };
    case "hostPath": {
      const line: SourcePart[] = [{ text: text(value.path), mono: true }];
      if (text(value.type) !== "")
        line.push({ text: ` ${text(value.type)}`, muted: true });
      return { type, source: [line] };
    }
    case "downwardAPI":
      return { type, source: [[{ text: fieldPaths(value), mono: true }]] };
    case "csi":
      return { type, source: [[{ text: text(value.driver), mono: true }]] };
    case "nfs":
      return {
        type,
        source: [
          [{ text: `${text(value.server)}:${text(value.path)}`, mono: true }],
        ],
      };
    case "ephemeral":
      return {
        type,
        source: [
          [
            podName
              ? linked(
                  "PersistentVolumeClaim",
                  `${podName}-${text(volume.name)}`,
                  namespace,
                )
              : { text: "Claim per Pod" },
          ],
        ],
      };
    case "image":
      return { type, source: [[{ text: text(value.reference), mono: true }]] };
    default:
      return { type, source: [] };
  }
}

/**
 * One item per `spec.volumes[]` of a Pod spec. Links point into `namespace`; an
 * ephemeral volume links to its claim only with the Pod's own name.
 */
export function volumeRows(
  spec: unknown,
  namespace: string | null,
  podName: string | null,
): VolumeItem[] {
  return list(fields(spec).volumes).map((v) => {
    const volume = fields(v);
    const name = text(volume.name);
    return {
      name,
      ...describeVolume(volume, namespace, podName),
      mounted: mountLines(spec, name),
    };
  });
}

/** `spec.template.spec` of a Deployment, StatefulSet, DaemonSet, ReplicaSet or Job. */
export function templatePodSpec(object: KubeObject): unknown {
  return fields(fields(fields(object).spec).template).spec;
}

/** `spec.jobTemplate.spec.template.spec` of a CronJob. */
export function cronJobPodSpec(object: KubeObject): unknown {
  const job = fields(fields(fields(object).spec).jobTemplate).spec;
  return fields(fields(job).template).spec;
}

/** A StatefulSet's `spec.volumeClaimTemplates[]` as Volumes items (spec H40). */
export function claimTemplateItems(object: KubeObject): VolumeItem[] {
  const spec = templatePodSpec(object);
  return list(fields(fields(object).spec).volumeClaimTemplates).map((t) => {
    const claim = fields(t);
    const name = text(fields(claim.metadata).name);
    const claimSpec = fields(claim.spec);
    const storageClass = text(claimSpec.storageClassName) || "default class";
    const storage = text(fields(fields(claimSpec.resources).requests).storage);
    const parts = [
      "One claim per Pod",
      storageClass,
      ...(storage ? [storage] : []),
    ];
    return {
      name,
      type: "Claim template",
      source: [[{ text: parts.join(", ") }]],
      mounted: mountLines(spec, name),
    };
  });
}
