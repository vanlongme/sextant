import { DoorOpen, Layers, type LucideIcon, Route, Split } from "lucide-react";
import { type IconPath, K8S_ICONS, type K8sIconName } from "./k8sIcons";

/** The Kubernetes Icons Set file of each kind that has one (spec E §14.1). */
const FILE: Readonly<Record<string, K8sIconName>> = {
  Pod: "pod",
  Deployment: "deploy",
  ReplicaSet: "rs",
  StatefulSet: "sts",
  DaemonSet: "ds",
  Job: "job",
  CronJob: "cronjob",
  Service: "svc",
  Ingress: "ing",
  ConfigMap: "cm",
  Secret: "secret",
  ServiceAccount: "sa",
  PersistentVolumeClaim: "pvc",
  Namespace: "ns",
};

/** Kinds the set has no icon for: the set's frame with a white Lucide glyph. */
const FRAMED: Readonly<Record<string, LucideIcon>> = {
  Gateway: DoorOpen,
  HTTPRoute: Route,
  GatewayClass: Layers,
};

/** The name of the icon a kind gets: its file, a framed glyph, the load balancer badge or `crd`. */
export function iconName(kind: string): string {
  if (FILE[kind]) return FILE[kind];
  if (FRAMED[kind]) return kind;
  if (kind === "LoadBalancer") return kind;
  return "crd";
}

const toProp = (key: string) =>
  key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function Path({ path }: { path: IconPath }) {
  const paint: Record<string, string> = {};
  for (const item of path.s.split(";")) {
    const at = item.indexOf(":");
    if (at > 0) paint[toProp(item.slice(0, at))] = item.slice(at + 1);
  }
  return <path d={path.d} transform={path.t || undefined} {...paint} />;
}

/** A circle around the frame's centre, for the load balancer badge. */
const circle = (r: number) =>
  `M${9.017 - r} 8.75a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const BADGE: IconPath[] = [
  { d: circle(8.4), s: "fill:#ffffff", t: "" },
  { d: circle(7.75), s: "fill:#5b6672", t: "" },
];

/** The glyph's box inside the frame, in the frame's units. */
const GLYPH_X = 4.697;
const GLYPH_Y = 4.43;
const GLYPH_SIZE = 8.64;

function Glyph({ icon: Icon, turn }: { icon: LucideIcon; turn?: number }) {
  const cx = GLYPH_X + GLYPH_SIZE / 2;
  const cy = GLYPH_Y + GLYPH_SIZE / 2;
  return (
    <g transform={turn ? `rotate(${turn} ${cx} ${cy})` : undefined}>
      <Icon
        x={GLYPH_X}
        y={GLYPH_Y}
        width={GLYPH_SIZE}
        height={GLYPH_SIZE}
        color="#ffffff"
        strokeWidth={1.7}
      />
    </g>
  );
}

export interface KindIconProps {
  kind: string;
  size: number;
  /** Where the icon's top-left corner sits inside an enclosing SVG. */
  x?: number;
  y?: number;
}

/** A kind's icon at `size` pixels, hidden from assistive technology (spec E §14.1). */
export function KindIcon({ kind, size, x, y }: KindIconProps) {
  const name = iconName(kind);
  const file: K8sIconName | undefined = FILE[kind];
  const framed: LucideIcon | undefined = FRAMED[kind];
  const packed = file
    ? K8S_ICONS[file]
    : name === "crd"
      ? K8S_ICONS.crd
      : K8S_ICONS.ing;
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox={packed.vb}
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {file || name === "crd"
        ? packed.paths.map((p) => <Path key={`${p.t}${p.d}`} path={p} />)
        : null}
      {framed ? (
        <>
          {K8S_ICONS.ing.paths.slice(0, 2).map((p) => (
            <Path key={`${p.t}${p.d}`} path={p} />
          ))}
          <Glyph icon={framed} />
        </>
      ) : null}
      {name === "LoadBalancer" ? (
        <>
          {BADGE.map((p) => (
            <Path key={`${p.t}${p.d}`} path={p} />
          ))}
          <Glyph icon={Split} turn={90} />
        </>
      ) : null}
    </svg>
  );
}
