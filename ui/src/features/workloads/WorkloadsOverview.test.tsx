import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import type { ClusterOutletContext } from "../cluster/ClusterLayout";
import { WorkloadsOverview } from "./WorkloadsOverview";

function info(
  group: string,
  plural: string,
  kind: string,
  over: Partial<ApiResourceInfo> = {},
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
    ...over,
  };
}

const PODS = info("", "pods", "Pod");
const DEPLOYMENTS = info("apps", "deployments", "Deployment");
const DAEMONSETS = info("apps", "daemonsets", "DaemonSet");
const STATEFULSETS = info("apps", "statefulsets", "StatefulSet");
const REPLICASETS = info("apps", "replicasets", "ReplicaSet");
const JOBS = info("batch", "jobs", "Job");
const CRONJOBS = info("batch", "cronjobs", "CronJob");
const EVENTS = info("", "events", "Event");
const ALL = [
  PODS,
  DEPLOYMENTS,
  DAEMONSETS,
  STATEFULSETS,
  REPLICASETS,
  JOBS,
  CRONJOBS,
  EVENTS,
];

function fakeBackend(uiState: Record<string, unknown> = {}) {
  const subs = new Map<string, (event: WatchEvent) => void>();
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) => uiState[a.key] ?? null,
    ui_state_set: (a: { key: string; value: unknown }) => {
      uiState[a.key] = a.value;
      return null;
    },
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
  });
  async function send(plural: string, event: WatchEvent) {
    await act(async () => {
      subs.get(plural)?.(event);
      await flush();
    });
  }
  async function snapshot(plural: string, items: KubeObject[]) {
    await send(plural, { type: "snapshot", items } as WatchEvent);
  }
  const subscribed = () =>
    backend
      .callsTo("resources_subscribe")
      .map((a) => (a.resource as ResourceRef).plural);
  return { backend, uiState, send, snapshot, subscribed };
}

type Fake = ReturnType<typeof fakeBackend>;

async function show(
  resources: ApiResourceInfo[] = ALL,
  over: Partial<ClusterOutletContext> = {},
) {
  const context: ClusterOutletContext = {
    clusterId: "c1",
    resources,
    resourcesLoading: false,
    resourcesError: null,
    ...over,
  };
  render(
    <MemoryRouter initialEntries={["/cluster/c1/workloads"]}>
      <Routes>
        <Route path="/cluster/:id" element={<Outlet context={context} />}>
          <Route path="workloads" element={<WorkloadsOverview />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
}

/** Every kind's first list, empty unless given. */
async function snapshots(fake: Fake, lists: Record<string, KubeObject[]>) {
  for (const plural of [
    "pods",
    "deployments",
    "daemonsets",
    "statefulsets",
    "replicasets",
    "jobs",
    "cronjobs",
    "events",
  ]) {
    await fake.snapshot(plural, lists[plural] ?? []);
  }
}

function pod(
  name: string,
  namespace: string,
  state: "running" | "pending" | "crashing" | "terminating",
): KubeObject {
  const running = { name: "app", ready: true, state: { running: {} } };
  const statuses = {
    running: { phase: "Running", containerStatuses: [running] },
    pending: { phase: "Pending" },
    crashing: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          ready: false,
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    },
    terminating: { phase: "Running", containerStatuses: [running] },
  };
  return {
    metadata: {
      name,
      namespace,
      ...(state === "terminating"
        ? { deletionTimestamp: "2026-11-14T00:00:00Z" }
        : {}),
    },
    spec: { containers: [{ name: "app" }] },
    status: statuses[state],
  };
}

const availableDeployment = (name: string, namespace: string): KubeObject => ({
  metadata: { name, namespace },
  spec: { replicas: 1 },
  status: {
    readyReplicas: 1,
    updatedReplicas: 1,
    conditions: [{ type: "Available", status: "True" }],
  },
});

function event(
  name: string,
  over: {
    namespace?: string;
    minutes?: number;
    type?: string;
    object?: string;
    message?: string;
  } = {},
): KubeObject {
  return {
    metadata: { name, namespace: over.namespace ?? "default", uid: name },
    type: over.type ?? "Normal",
    involvedObject: { kind: "Pod", name: over.object ?? `pod-${name}` },
    message: over.message ?? `message ${name}`,
    lastTimestamp: new Date(
      Date.now() - (over.minutes ?? 1) * 60_000,
    ).toISOString(),
  };
}

const kindsTable = () => screen.getByRole("table", { name: "Workload kinds" });
const eventsTable = () => screen.getByRole("table", { name: "Recent events" });
const kindRow = (plural: string) =>
  within(kindsTable()).getByTestId(`workload-kind-${plural}`);
/** Kind, Total, Healthy, Pending and Failing as shown. */
const cells = (plural: string) =>
  within(kindRow(plural))
    .getAllByRole("cell")
    .map((c) => c.textContent);

function toggleNamespace(namespace: string) {
  fireEvent.keyDown(screen.getByTestId("namespace-filter"), { key: "Enter" });
  fireEvent.click(screen.getByTestId(`namespace-option-${namespace}`));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}

beforeEach(() => {
  resetResourcesForTest();
});
afterEach(() => {
  resetResourcesForTest();
});

test("each kind is counted by its list's status, in the sidebar's order", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {
    pods: [
      pod("a", "shop", "running"),
      pod("b", "shop", "pending"),
      pod("c", "shop", "crashing"),
      pod("d", "shop", "terminating"),
    ],
    deployments: [availableDeployment("web", "shop")],
  });

  expect(screen.getByTestId("workloads-overview-title").textContent).toBe(
    "Workloads",
  );
  const kinds = within(kindsTable())
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]?.textContent);
  expect(kinds).toEqual([
    "Pods",
    "Deployments",
    "DaemonSets",
    "StatefulSets",
    "ReplicaSets",
    "Jobs",
    "CronJobs",
  ]);
  // The Terminating pod counts only in Total.
  expect(cells("pods")).toEqual(["Pods", "4", "1", "1", "1"]);
  expect(cells("deployments")).toEqual(["Deployments", "1", "1", "0", "0"]);
  expect(cells("cronjobs")).toEqual(["CronJobs", "0", "0", "0", "0"]);
});

test("failing objects show a danger badge, and none a plain 0", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {
    pods: [pod("c", "shop", "crashing"), pod("e", "shop", "crashing")],
    deployments: [availableDeployment("web", "shop")],
  });
  const failing = (plural: string) =>
    within(kindRow(plural)).getAllByRole("cell")[4] as HTMLElement;
  const badge = failing("pods").firstElementChild as HTMLElement;
  expect(badge.textContent).toBe("2");
  expect(badge.className).toMatch(/\bbadge\b/);
  expect(badge.className).toMatch(/\bdanger\b/);
  expect(failing("deployments").textContent).toBe("0");
  expect(failing("deployments").querySelector(".badge")).toBeNull();
});

test("a kind links to its list screen", async () => {
  const fake = fakeBackend();
  await show();
  await snapshots(fake, {});
  expect(
    within(kindRow("pods"))
      .getByRole("link", { name: "Pods" })
      .getAttribute("href"),
  ).toBe("/cluster/c1/r/core/pods");
  expect(
    within(kindRow("cronjobs"))
      .getByRole("link", { name: "CronJobs" })
      .getAttribute("href"),
  ).toBe("/cluster/c1/r/batch/cronjobs");
});

test("a kind still loading shows a spinner in its own row", async () => {
  const fake = fakeBackend();
  await show();
  await fake.snapshot("pods", [pod("a", "shop", "running")]);
  expect(cells("pods")).toEqual(["Pods", "1", "1", "0", "0"]);
  expect(within(kindRow("pods")).queryByRole("status")).toBeNull();
  expect(within(kindRow("deployments")).getByRole("status")).toBeTruthy();
  expect(screen.getByTestId("workloads-overview-title")).toBeTruthy();
});

test("while discovery runs, every kind is loading", async () => {
  fakeBackend();
  await show([], { resourcesLoading: true });
  for (const plural of ["pods", "jobs", "cronjobs"]) {
    expect(within(kindRow(plural)).getByRole("status")).toBeTruthy();
  }
});

test("a kind not served, not listable or forbidden shows a dash, and the rest still count", async () => {
  const fake = fakeBackend();
  await show([
    PODS,
    DEPLOYMENTS,
    DAEMONSETS,
    STATEFULSETS,
    REPLICASETS,
    { ...JOBS, canList: false },
    EVENTS,
  ]);
  await fake.send("daemonsets", {
    type: "status",
    status: "forbidden",
    message: "daemonsets is forbidden",
  });
  await snapshots(fake, { pods: [pod("a", "shop", "running")] });

  // A kind that may not be listed is not even watched.
  expect(fake.subscribed()).not.toContain("jobs");
  expect(fake.subscribed()).not.toContain("cronjobs");
  const dash = ["—", "—", "—", "—"];
  expect(cells("cronjobs")).toEqual(["CronJobs", ...dash]);
  expect(cells("jobs")).toEqual(["Jobs", ...dash]);
  expect(cells("daemonsets")).toEqual(["DaemonSets", ...dash]);
  expect(within(kindRow("jobs")).queryByRole("link")).toBeNull();
  expect(
    within(kindRow("cronjobs")).getAllByTitle(/does not serve/),
  ).toHaveLength(4);
  expect(
    within(kindRow("daemonsets")).getAllByTitle("daemonsets is forbidden"),
  ).toHaveLength(4);
  expect(cells("pods")).toEqual(["Pods", "1", "1", "0", "0"]);
});

test("recent events come newest first, at most ten, with their type as a badge", async () => {
  const fake = fakeBackend();
  await show();
  const events = Array.from({ length: 12 }, (_, i) =>
    event(`e${i}`, { minutes: 12 - i }),
  );
  events[11] = event("e11", {
    minutes: 0,
    type: "Warning",
    object: "web-7f9c5d-x2k9p",
    message: "Back-off restarting failed container api",
  });
  await snapshots(fake, { events });

  const rows = within(eventsTable()).getAllByTestId("workload-event");
  expect(rows).toHaveLength(10);
  const first = within(rows[0] as HTMLElement).getAllByRole("cell");
  expect(first[1]?.querySelector(".badge")?.className).toMatch(/\bwarn\b/);
  expect(first[1]?.textContent).toBe("Warning");
  expect(
    within(first[2] as HTMLElement).getByTitle("Pod/web-7f9c5d-x2k9p"),
  ).toBeTruthy();
  expect(
    within(first[3] as HTMLElement).getByTitle(
      "Back-off restarting failed container api",
    ),
  ).toBeTruthy();
  const second = within(rows[1] as HTMLElement).getAllByRole("cell");
  expect(second[1]?.querySelector(".badge")?.className).toMatch(/\bneutral\b/);
  expect(second[2]?.textContent).toBe("Pod/pod-e10");
  // e0 and e1 are the oldest, so they are left out.
  expect(screen.queryByText("Pod/pod-e1")).toBeNull();
  expect(screen.queryByText("Pod/pod-e0")).toBeNull();
});

test("events the user may not list leave the kinds alone", async () => {
  const fake = fakeBackend();
  await show();
  await fake.send("events", {
    type: "status",
    status: "forbidden",
    message: "events is forbidden",
  });
  await snapshots(fake, { pods: [pod("a", "shop", "running")] });
  expect(screen.getByTestId("workloads-events-status").textContent).toContain(
    "events is forbidden",
  );
  expect(cells("pods")).toEqual(["Pods", "1", "1", "0", "0"]);
});

test("the namespace filter of the lists limits the counts and the events", async () => {
  const fake = fakeBackend({ "namespaces:c1": ["team-a"] });
  await show();
  await snapshots(fake, {
    pods: [
      pod("a", "team-a", "running"),
      pod("b", "team-b", "crashing"),
      pod("c", "team-b", "crashing"),
    ],
    events: [
      event("ea", { namespace: "team-a" }),
      event("eb", { namespace: "team-b" }),
    ],
  });
  await waitFor(() =>
    expect(screen.getByTestId("namespace-filter").textContent).toContain(
      "team-a",
    ),
  );
  expect(cells("pods")).toEqual(["Pods", "1", "1", "0", "0"]);
  expect(screen.getByText("Pod/pod-ea")).toBeTruthy();
  expect(screen.queryByText("Pod/pod-eb")).toBeNull();

  // The open menu hides the page from the accessibility tree, so it closes each time.
  toggleNamespace("team-b");
  expect(cells("pods")).toEqual(["Pods", "3", "1", "0", "2"]);
  expect(screen.getByText("Pod/pod-eb")).toBeTruthy();
  toggleNamespace("team-a");
  expect(cells("pods")).toEqual(["Pods", "2", "0", "0", "2"]);
  expect(screen.queryByText("Pod/pod-ea")).toBeNull();
  await waitFor(() =>
    expect(fake.uiState["namespaces:c1"]).toEqual(["team-b"]),
  );
});
