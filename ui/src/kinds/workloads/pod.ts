import type { Tone } from "../../design/Badge";
import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

interface Terminated {
  reason?: string;
  signal?: number;
  exitCode?: number;
}
interface ContainerStatus {
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

export interface ContainerInfo {
  name: string;
  init: boolean;
  image: string;
  state: string;
  ready: boolean;
  restarts: number;
  ports: string[];
  env: string[];
  mounts: string[];
  probes: string[];
  requests: string[];
  limits: string[];
}

// biome-ignore lint/suspicious/noExplicitAny: container specs are free-form JSON.
type Json = any;

/** An environment variable; references are named and never resolved. */
export function envText(env: Json): string {
  const name = env?.name ?? "";
  const from = env?.valueFrom;
  if (from?.secretKeyRef) {
    return `${name} from secret ${from.secretKeyRef.name}/${from.secretKeyRef.key}`;
  }
  if (from?.configMapKeyRef) {
    return `${name} from configmap ${from.configMapKeyRef.name}/${from.configMapKeyRef.key}`;
  }
  if (from?.fieldRef) return `${name} from field ${from.fieldRef.fieldPath}`;
  if (from?.resourceFieldRef) {
    return `${name} from resource ${from.resourceFieldRef.resource}`;
  }
  return `${name}=${env?.value ?? ""}`;
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

function stateText(status: ContainerStatus | undefined): string {
  const state = status?.state;
  if (state?.running) return "Running";
  if (state?.waiting) return `Waiting: ${state.waiting.reason ?? "Unknown"}`;
  if (state?.terminated) {
    const t = state.terminated;
    return `Terminated: ${t.reason ?? "Unknown"} (exit ${t.exitCode ?? 0})`;
  }
  return "Not started";
}

function quantities(map: Record<string, string> | undefined): string[] {
  return Object.entries(map ?? {}).map(([k, v]) => `${k} ${v}`);
}

function describeContainer(
  spec: Json,
  status: ContainerStatus | undefined,
  init: boolean,
): ContainerInfo {
  const envFrom: string[] = (spec.envFrom ?? []).map((source: Json) => {
    const prefix = source.prefix ? ` (prefix ${source.prefix})` : "";
    if (source.secretRef)
      return `all of secret ${source.secretRef.name}${prefix}`;
    return `all of configmap ${source.configMapRef?.name ?? ""}${prefix}`;
  });
  const probes: string[] = [];
  for (const [field, label] of [
    ["livenessProbe", "liveness"],
    ["readinessProbe", "readiness"],
    ["startupProbe", "startup"],
  ] as const) {
    if (spec[field]) probes.push(`${label}: ${probeText(spec[field])}`);
  }
  return {
    name: spec.name ?? "",
    init,
    image: spec.image ?? "",
    state: stateText(status),
    ready: Boolean(status?.ready),
    restarts: status?.restartCount ?? 0,
    ports: (spec.ports ?? []).map(
      (p: Json) =>
        `${p.name ? `${p.name} ` : ""}${p.containerPort}/${p.protocol ?? "TCP"}`,
    ),
    env: [...(spec.env ?? []).map(envText), ...envFrom],
    mounts: (spec.volumeMounts ?? []).map(
      (m: Json) => `${m.mountPath} from ${m.name}${m.readOnly ? " (ro)" : ""}`,
    ),
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
