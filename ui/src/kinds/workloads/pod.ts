import type { Tone } from "../../design/Badge";
import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

interface Terminated {
  reason?: string;
  signal?: number;
  exitCode?: number;
}
export interface ContainerStatus {
  name?: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  state?: {
    running?: object;
    waiting?: { reason?: string };
    terminated?: Terminated;
  };
}
interface Condition {
  type: string;
  status?: string;
  reason?: string;
}

function isRestartable(c: { restartPolicy?: string } | undefined) {
  return c?.restartPolicy === "Always";
}

function terminatedText(t: Terminated, prefix = "") {
  if (t.reason) return `${prefix}${t.reason}`;
  if (t.signal) return `${prefix}Signal:${t.signal}`;
  return `${prefix}ExitCode:${t.exitCode ?? 0}`;
}

export function podSummary(pod: KubeObject) {
  const status = pod.status ?? {};
  const spec = pod.spec ?? {};
  const conditions: Condition[] = status.conditions ?? [];
  const inits: { name: string; restartPolicy?: string }[] =
    spec.initContainers ?? [];
  const byName = new Map(inits.map((c) => [c.name, c]));
  const total =
    (spec.containers ?? []).length + inits.filter(isRestartable).length;
  let ready = 0;
  let restarts = 0;
  let restartableRestarts = 0;
  let reason: string = status.reason || status.phase || "Unknown";
  for (const c of conditions) {
    if (c.type === "PodScheduled" && c.reason === "SchedulingGated")
      reason = "SchedulingGated";
  }

  let initializing = false;
  const initStatuses: ContainerStatus[] = status.initContainerStatuses ?? [];
  for (let i = 0; i < initStatuses.length; i++) {
    const c = initStatuses[i];
    const restartable = isRestartable(byName.get(c.name ?? ""));
    restarts += c.restartCount ?? 0;
    if (restartable) restartableRestarts += c.restartCount ?? 0;
    const terminated = c.state?.terminated;
    const waiting = c.state?.waiting;
    if (terminated && (terminated.exitCode ?? 0) === 0) continue;
    if (restartable && c.started) {
      if (c.ready) ready++;
      continue;
    }
    if (terminated) reason = terminatedText(terminated, "Init:");
    else if (waiting?.reason && waiting.reason !== "PodInitializing")
      reason = `Init:${waiting.reason}`;
    else reason = `Init:${i}/${inits.length}`;
    initializing = true;
    break;
  }

  const holds = (type: string) =>
    conditions.some((c) => c.type === type && c.status === "True");
  if (!initializing || holds("Initialized")) {
    restarts = restartableRestarts;
    let hasRunning = false;
    const statuses: ContainerStatus[] = status.containerStatuses ?? [];
    for (let i = statuses.length - 1; i >= 0; i--) {
      const c = statuses[i];
      restarts += c.restartCount ?? 0;
      if (c.state?.waiting?.reason) reason = c.state.waiting.reason;
      else if (c.state?.terminated) reason = terminatedText(c.state.terminated);
      else if (c.ready && c.state?.running) {
        hasRunning = true;
        ready++;
      }
    }
    if (reason === "Completed" && hasRunning) {
      reason = holds("Ready") ? "Running" : "NotReady";
    }
  }

  const deleting = Boolean(pod.metadata.deletionTimestamp);
  if (deleting && status.reason === "NodeLost") reason = "Unknown";
  else if (
    deleting &&
    status.phase !== "Succeeded" &&
    status.phase !== "Failed"
  )
    reason = "Terminating";

  return { status: reason, ready: `${ready}/${total}`, restarts };
}

const OK = new Set(["Running", "Completed", "Succeeded"]);
const INFO = new Set([
  "ContainerCreating",
  "PodInitializing",
  "SchedulingGated",
]);
const WARN = new Set(["Pending", "NotReady"]);
const NEUTRAL = new Set(["Terminating", "Unknown"]);

function podTone(status: string): Tone {
  if (OK.has(status)) return "ok";
  if (INFO.has(status) || /^Init:\d+\/\d+$/.test(status)) return "info";
  if (WARN.has(status)) return "warn";
  if (NEUTRAL.has(status)) return "neutral";
  return "danger";
}

export function podStatus(pod: KubeObject): StatusInfo {
  const label = podSummary(pod).status;
  return { label, tone: podTone(label) };
}

/** A declared container port; what the spec leaves out is null. */
export interface ContainerPort {
  containerPort: number | null;
  name: string | null;
  protocol: string | null;
}

/** A whole ConfigMap or Secret a container reads its environment from. */
export interface EnvFromSource {
  kind: "ConfigMap" | "Secret";
  name: string;
  prefix: string | null;
}

/** A variable whose value comes from elsewhere; it is named and never resolved (milestone F6). */
export type EnvRef =
  | {
      name: string;
      from: "key";
      kind: "ConfigMap" | "Secret";
      source: string;
      key: string;
    }
  | { name: string; from: "field"; path: string }
  | { name: string; from: "resource"; resource: string };

export interface ContainerInfo {
  name: string;
  init: boolean;
  image: string;
  /** The state badge (spec H38). */
  state: StatusInfo;
  ready: boolean;
  restarts: number;
  /** `‹port›/‹protocol›`, one per declared port. */
  ports: string[];
  /** The same ports as data, in the same order. */
  portSpecs: ContainerPort[];
  /** `NAME=value` for each variable with a literal value. */
  env: string[];
  envFrom: EnvFromSource[];
  envRefs: EnvRef[];
  probes: string[];
  /** `cpu 250m · memory 512Mi`; empty with none. */
  requests: string;
  limits: string;
}

// biome-ignore lint/suspicious/noExplicitAny: container specs are free-form JSON.
type Json = any;

function envRefOf(env: Json): EnvRef | null {
  const name: string = env?.name ?? "";
  const from = env?.valueFrom;
  if (from?.configMapKeyRef) {
    return {
      name,
      from: "key",
      kind: "ConfigMap",
      source: from.configMapKeyRef.name ?? "",
      key: from.configMapKeyRef.key ?? "",
    };
  }
  if (from?.secretKeyRef) {
    return {
      name,
      from: "key",
      kind: "Secret",
      source: from.secretKeyRef.name ?? "",
      key: from.secretKeyRef.key ?? "",
    };
  }
  if (from?.fieldRef) {
    return { name, from: "field", path: from.fieldRef.fieldPath ?? "" };
  }
  if (from?.resourceFieldRef) {
    return {
      name,
      from: "resource",
      resource: from.resourceFieldRef.resource ?? "",
    };
  }
  return null;
}

function envFromOf(source: Json): EnvFromSource[] {
  const prefix =
    typeof source?.prefix === "string" && source.prefix !== ""
      ? source.prefix
      : null;
  if (source?.secretRef) {
    return [{ kind: "Secret", name: source.secretRef.name ?? "", prefix }];
  }
  if (source?.configMapRef) {
    return [
      { kind: "ConfigMap", name: source.configMapRef.name ?? "", prefix },
    ];
  }
  return [];
}

/** A probe the way `kubectl describe` prints it, with the Kubernetes defaults filled in. */
export function probeText(probe: Json): string {
  let action = "unknown";
  if (probe?.httpGet) {
    action = `http-get :${probe.httpGet.port}${probe.httpGet.path ?? ""}`;
  } else if (probe?.tcpSocket) {
    action = `tcp-socket :${probe.tcpSocket.port}`;
  } else if (probe?.exec) {
    action = `exec [${(probe.exec.command ?? []).join(" ")}]`;
  } else if (probe?.grpc) {
    action = `grpc :${probe.grpc.port}`;
  }
  const delay = probe?.initialDelaySeconds ?? 0;
  const timeout = probe?.timeoutSeconds ?? 1;
  const period = probe?.periodSeconds ?? 10;
  const success = probe?.successThreshold ?? 1;
  const failure = probe?.failureThreshold ?? 3;
  return `${action} delay=${delay}s timeout=${timeout}s period=${period}s #success=${success} #failure=${failure}`;
}

/** Waiting reasons that mean the container cannot start. */
const FAILING = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
]);

/** A container's state as a badge (spec H38). */
export function containerState(
  status: ContainerStatus | undefined,
): StatusInfo {
  const state = status?.state;
  if (state?.running) return { label: "Running", tone: "ok" };
  if (state?.waiting) {
    const reason = state.waiting.reason;
    if (reason && FAILING.has(reason)) return { label: reason, tone: "danger" };
    return { label: reason || "Waiting", tone: "info" };
  }
  if (state?.terminated) {
    const t = state.terminated;
    if ((t.exitCode ?? 0) === 0) {
      return { label: t.reason || "Completed", tone: "neutral" };
    }
    return { label: t.reason || "Error", tone: "danger" };
  }
  return { label: "Not started", tone: "neutral" };
}

function quantities(map: Record<string, string> | undefined): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
}

function describeContainer(
  spec: Json,
  status: ContainerStatus | undefined,
  init: boolean,
): ContainerInfo {
  const probes: string[] = [];
  for (const [field, label] of [
    ["livenessProbe", "liveness"],
    ["readinessProbe", "readiness"],
    ["startupProbe", "startup"],
  ] as const) {
    if (spec[field]) probes.push(`${label}: ${probeText(spec[field])}`);
  }
  const env: Json[] = spec.env ?? [];
  return {
    name: spec.name ?? "",
    init,
    image: spec.image ?? "",
    state: containerState(status),
    ready: Boolean(status?.ready),
    restarts: status?.restartCount ?? 0,
    ports: (spec.ports ?? []).map(
      (p: Json) => `${p.containerPort}/${p.protocol ?? "TCP"}`,
    ),
    portSpecs: (spec.ports ?? []).map(
      (p: Json): ContainerPort => ({
        containerPort:
          typeof p.containerPort === "number" ? p.containerPort : null,
        name: typeof p.name === "string" ? p.name : null,
        protocol: typeof p.protocol === "string" ? p.protocol : null,
      }),
    ),
    env: env
      .filter((e) => !e?.valueFrom)
      .map((e) => `${e?.name ?? ""}=${e?.value ?? ""}`),
    envFrom: (spec.envFrom ?? []).flatMap(envFromOf),
    envRefs: env.map(envRefOf).filter((r): r is EnvRef => r !== null),
    probes,
    requests: quantities(spec.resources?.requests),
    limits: quantities(spec.resources?.limits),
  };
}

/** Init containers first, then regular ones, each joined to its status by name. */
export function containersOf(pod: KubeObject): ContainerInfo[] {
  const spec = pod.spec ?? {};
  const status = pod.status ?? {};
  const find = (list: ContainerStatus[] | undefined, name: string) =>
    (list ?? []).find((c) => c.name === name);
  return [
    ...(spec.initContainers ?? []).map((c: Json) =>
      describeContainer(c, find(status.initContainerStatuses, c.name), true),
    ),
    ...(spec.containers ?? []).map((c: Json) =>
      describeContainer(c, find(status.containerStatuses, c.name), false),
    ),
  ];
}
