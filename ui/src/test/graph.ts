import { act } from "@testing-library/react";
import { bridgeEdges } from "../features/map/bridges";
import { kindView, visibleModel } from "../features/map/filters";
import {
  buildModel,
  type MapModel,
  namespaceView,
} from "../features/map/model";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { GraphEdge } from "../ipc/generated/GraphEdge";
import type { GraphEvent } from "../ipc/generated/GraphEvent";
import type { GraphNamespaceCount } from "../ipc/generated/GraphNamespaceCount";
import type { GraphNode } from "../ipc/generated/GraphNode";
import type { GraphRel } from "../ipc/generated/GraphRel";
import { type Backend, flush, mockBackend } from "./ipc";

export type SnapshotEvent = Extract<GraphEvent, { type: "snapshot" }>;

/** The list each kind of the graph belongs to, as `group` and `plural`. */
const LISTS: Record<string, [string, string]> = {
  Pod: ["", "pods"],
  Service: ["", "services"],
  ConfigMap: ["", "configmaps"],
  Secret: ["", "secrets"],
  ServiceAccount: ["", "serviceaccounts"],
  PersistentVolumeClaim: ["", "persistentvolumeclaims"],
  Deployment: ["apps", "deployments"],
  ReplicaSet: ["apps", "replicasets"],
  StatefulSet: ["apps", "statefulsets"],
  DaemonSet: ["apps", "daemonsets"],
  Job: ["batch", "jobs"],
  CronJob: ["batch", "cronjobs"],
  Ingress: ["networking.k8s.io", "ingresses"],
  Gateway: ["gateway.networking.k8s.io", "gateways"],
  HTTPRoute: ["gateway.networking.k8s.io", "httproutes"],
  GatewayClass: ["gateway.networking.k8s.io", "gatewayclasses"],
};

/** A node from its id, `‹Kind›/‹namespace›/‹name›`, healthy and without facts. */
export function gnode(id: string, over: Partial<GraphNode> = {}): GraphNode {
  const first = id.indexOf("/");
  const second = id.indexOf("/", first + 1);
  const kind = id.slice(0, first);
  const [group, plural] = LISTS[kind] ?? ["", ""];
  return {
    id,
    kind,
    group,
    plural,
    namespace: id.slice(first + 1, second),
    name: id.slice(second + 1),
    created: null,
    status: "nominal",
    statusText: null,
    facts: [],
    ...over,
  };
}

export function gedge(from: string, rel: GraphRel, to: string): GraphEdge {
  return { from, rel, to };
}

/** Node counts per namespace, as the backend sends them: cluster scope left out. */
export function countsOf(nodes: GraphNode[]): GraphNamespaceCount[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.namespace !== "") {
      counts.set(n.namespace, (counts.get(n.namespace) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, count]) => ({ namespace, nodes: count }));
}

export function snapshotOf(
  nodes: GraphNode[],
  edges: GraphEdge[],
  over: Partial<SnapshotEvent> = {},
): SnapshotEvent {
  return {
    type: "snapshot",
    nodes,
    edges,
    counts: countsOf(nodes),
    missing: [],
    gatewayApi: true,
    ...over,
  };
}

/** Ids of the demo graph, named for what they are. */
export const DEMO = {
  deployment: "Deployment/shop/web",
  replicaSet: "ReplicaSet/shop/web-7d9",
  podA: "Pod/shop/web-7d9-a",
  podB: "Pod/shop/web-7d9-b",
  service: "Service/shop/web",
  ingress: "Ingress/shop/web",
  route: "HTTPRoute/shop/web",
  configMap: "ConfigMap/shop/web-config",
  secret: "Secret/shop/web-secret",
  account: "ServiceAccount/shop/web",
  claim: "PersistentVolumeClaim/shop/data-web",
  statefulSet: "StatefulSet/shop/db",
  dbPod: "Pod/shop/db-0",
  dbClaim: "PersistentVolumeClaim/shop/data-db-0",
  gateway: "Gateway/edge/public",
  gatewayClass: "GatewayClass//shared",
  ingressLb: "LoadBalancer//10.0.0.5",
  gatewayLb: "LoadBalancer//203.0.113.24",
  cronJob: "CronJob/jobs/nightly",
  job: "Job/jobs/nightly-1",
  jobPod: "Pod/jobs/nightly-1-x",
  token: "Secret/jobs/token",
} as const;

/**
 * A small cluster with every kind and relation of the map: a Deployment with two
 * Pods behind a Service, an Ingress and an HTTPRoute, a shared Gateway in another
 * namespace with its class and load balancer, a StatefulSet with a claim, and a
 * CronJob whose Pod reads a Secret.
 */
export function demoGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const d = DEMO;
  const nodes = [
    gnode(d.deployment, {
      created: "2026-11-10T10:00:00Z",
      facts: [
        ["Replicas", "1/2 available"],
        ["Strategy", "RollingUpdate"],
        ["Image", "web:1.4"],
      ],
      status: "warning",
      statusText: "1 of 2 available",
    }),
    gnode(d.replicaSet, {
      facts: [
        ["Pods", "2"],
        ["Ready", "1"],
        ["Revision", "3"],
      ],
      status: "warning",
      statusText: "1 of 2 Pods ready",
    }),
    gnode(d.podA, {
      created: "2026-11-12T08:00:00Z",
      facts: [
        ["Ready", "1/1"],
        ["Restarts", "0"],
        ["Node", "worker-1"],
      ],
      statusText: "Running",
    }),
    gnode(d.podB, {
      facts: [
        ["Ready", "0/1"],
        ["Restarts", "7"],
        ["Node", "worker-2"],
      ],
      status: "critical",
      statusText: "CrashLoopBackOff",
    }),
    gnode(d.service, {
      facts: [
        ["Type", "ClusterIP"],
        ["Ports", "80/TCP"],
        ["Selector", "app=web"],
      ],
    }),
    gnode(d.ingress, { facts: [["Address", "10.0.0.5"]] }),
    gnode(d.route, {
      facts: [
        ["Parents", "edge/public"],
        ["Backends", "web:80"],
      ],
    }),
    gnode(d.configMap, { status: "neutral", facts: [["Keys", "2"]] }),
    gnode(d.secret, {
      status: "neutral",
      facts: [
        ["Type", "Opaque"],
        ["Keys", "1"],
      ],
    }),
    gnode(d.account, {
      status: "neutral",
      facts: [["Automount token", "Yes"]],
    }),
    gnode(d.claim, { status: "neutral", statusText: "Bound" }),
    gnode(d.statefulSet, { facts: [["Replicas", "1/1 ready"]] }),
    gnode(d.dbPod, { statusText: "Running" }),
    gnode(d.dbClaim, { status: "neutral", statusText: "Bound" }),
    gnode(d.gateway, {
      status: "warning",
      statusText: "Not programmed yet",
    }),
    gnode(d.gatewayClass, {
      status: "warning",
      statusText: "Waiting for the controller",
    }),
    gnode(d.ingressLb, {
      status: "neutral",
      facts: [["Address", "10.0.0.5"]],
    }),
    gnode(d.gatewayLb, {
      status: "neutral",
      facts: [["Address", "203.0.113.24"]],
    }),
    gnode(d.cronJob, {
      facts: [
        ["Schedule", "0 3 * * *"],
        ["Suspend", "No"],
      ],
    }),
    gnode(d.job, {
      status: "neutral",
      statusText: "Complete",
      facts: [
        ["Completions", "1/1"],
        ["Active", "0"],
        ["Duration", "3m4s"],
      ],
    }),
    gnode(d.jobPod, { status: "neutral", statusText: "Completed" }),
    gnode(d.token, { status: "neutral" }),
  ];
  const edges = [
    gedge(d.deployment, "owns", d.replicaSet),
    gedge(d.replicaSet, "owns", d.podA),
    gedge(d.replicaSet, "owns", d.podB),
    gedge(d.statefulSet, "owns", d.dbPod),
    gedge(d.cronJob, "owns", d.job),
    gedge(d.job, "owns", d.jobPod),
    gedge(d.service, "selects", d.podA),
    gedge(d.service, "selects", d.podB),
    gedge(d.ingressLb, "routes", d.ingress),
    gedge(d.ingress, "routes", d.service),
    gedge(d.gatewayLb, "routes", d.gateway),
    gedge(d.gateway, "routes", d.route),
    gedge(d.route, "routes", d.service),
    gedge(d.gateway, "class", d.gatewayClass),
    gedge(d.podA, "mounts", d.configMap),
    gedge(d.podB, "mounts", d.configMap),
    gedge(d.podA, "env", d.secret),
    gedge(d.podB, "env", d.secret),
    gedge(d.podA, "runsAs", d.account),
    gedge(d.podB, "runsAs", d.account),
    gedge(d.podA, "claims", d.claim),
    gedge(d.dbPod, "claims", d.dbClaim),
    gedge(d.jobPod, "env", d.token),
  ];
  return { nodes, edges };
}

/** A served resource the current user may do anything with, as discovery lists it. */
export function servedResource(
  kind: string,
  group: string,
  plural: string,
  namespaced = true,
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

/**
 * `size` ReplicaSets in namespace `loop` that own each other in a ring (one that owns
 * itself when `size` is 1), and a Pod the first one owns. Kubernetes allows such owner
 * references, so the map must still draw them.
 */
export function ownsCycle(size: number): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const sets = Array.from({ length: size }, (_, i) =>
    gnode(`ReplicaSet/loop/rs-${i}`),
  );
  const pod = gnode("Pod/loop/pod");
  const edges = sets.map((s, i) =>
    gedge(s.id, "owns", sets[(i + 1) % size].id),
  );
  edges.push(gedge(sets[0].id, "owns", pod.id));
  return { nodes: [...sets, pod], edges };
}

export function demoSnapshot(over: Partial<SnapshotEvent> = {}): SnapshotEvent {
  const { nodes, edges } = demoGraph();
  return snapshotOf(nodes, edges, over);
}

export interface GraphBackend {
  backend: Backend;
  /** The subscription ids still open, oldest first. */
  open(): string[];
  /**
   * Sends an event on one open subscription, or on every open one, and lets it
   * render. A failure ends the subscriptions it is sent on, as the backend does.
   */
  send(event: GraphEvent, subscriptionId?: string): Promise<void>;
  /** The channel of a subscription, open or not, to send what a late backend would. */
  channel(subscriptionId: string): (event: GraphEvent) => void;
}

/**
 * A backend whose graph subscriptions answer `g1`, `g2`… and keep their channels,
 * so a test can send snapshots and failures. `extra` adds other handlers.
 */
export function graphBackend(
  extra: Parameters<typeof mockBackend>[0] = {},
): GraphBackend {
  const channels = new Map<string, (event: GraphEvent) => void>();
  const open = new Set<string>();
  let seq = 0;
  const backend = mockBackend({
    resource_graph_subscribe: (a: {
      onEvent: { onmessage: (event: GraphEvent) => void };
    }) => {
      seq += 1;
      const id = `g${seq}`;
      channels.set(id, a.onEvent.onmessage);
      open.add(id);
      return id;
    },
    resource_graph_unsubscribe: (a: { subscriptionId: string }) => {
      open.delete(a.subscriptionId);
      return null;
    },
    ...extra,
  });
  return {
    backend,
    open: () => [...open],
    send: async (event, subscriptionId) => {
      await act(async () => {
        for (const id of [...open]) {
          if (subscriptionId !== undefined && id !== subscriptionId) continue;
          channels.get(id)?.(event);
          if (event.type === "failure") open.delete(id);
        }
        await flush();
      });
    },
    channel: (subscriptionId) => (event) => {
      channels.get(subscriptionId)?.(event);
    },
  };
}

/**
 * A graph as the cluster map draws it with `kinds` hidden: the shown nodes, their real
 * edges and the bridges through the hidden ones (spec H63). The demo graph by default.
 */
export function drawnHiding(
  kinds: readonly string[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] } = demoGraph(),
): MapModel {
  const model = buildModel(graph.nodes, graph.edges);
  const view = namespaceView(model, new Set());
  const shownIds = kindView(model, view, new Set(kinds));
  return visibleModel(
    model,
    shownIds,
    bridgeEdges(model, view, new Set(shownIds)),
  );
}
