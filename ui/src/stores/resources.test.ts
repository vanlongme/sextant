import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { WatchEvent } from "../ipc/generated/WatchEvent";
import type { KubeObject } from "../kinds/objects";
import { flush, mockBackend } from "../test/ipc";
import {
  findResource,
  type ResourceListState,
  resetResourcesForTest,
  useApiResources,
  useResourceList,
} from "./resources";

const pods: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};

function pod(name: string, namespace = "default", rv = "1"): KubeObject {
  return { metadata: { name, namespace, resourceVersion: rv } };
}

interface Sub {
  clusterId: string;
  resource: ResourceRef;
  send(event: WatchEvent): Promise<void>;
}

function setup() {
  const subs: Sub[] = [];
  const backend = mockBackend({
    resources_subscribe: (args: {
      clusterId: string;
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      subs.push({
        clusterId: args.clusterId,
        resource: args.resource,
        send: async (event) => {
          await act(async () => {
            args.onEvent.onmessage(event);
            await flush();
          });
        },
      });
      return `sub-${subs.length}`;
    },
    resources_unsubscribe: () => null,
  });
  return { subs, backend };
}

const snapshot = (...items: KubeObject[]): WatchEvent => ({
  type: "snapshot",
  items,
});
const status = (
  s: "syncing" | "live" | "reconnecting" | "notServed" | "forbidden",
  message: string | null = null,
): WatchEvent => ({ type: "status", status: s, message });

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

async function mount(clusterId = "a", resource: ResourceRef | null = pods) {
  const hook = renderHook(
    (props: { c: string; r: ResourceRef | null }) =>
      useResourceList(props.c, props.r),
    { initialProps: { c: clusterId, r: resource } },
  );
  await act(flush);
  return hook;
}

test("snapshot replaces items, batch applies upserts and deletes", async () => {
  const { subs } = setup();
  const { result } = await mount();
  expect(result.current.loading).toBe(true);
  expect(result.current.items).toEqual([]);

  await subs[0].send(snapshot(pod("a"), pod("b")));
  expect(result.current.loading).toBe(false);
  expect(result.current.items.map((o) => o.metadata.name)).toEqual(["a", "b"]);

  await subs[0].send({
    type: "batch",
    upserts: [pod("b", "default", "2"), pod("c")],
    deletes: [{ namespace: "default", name: "a" }],
  });
  const names = result.current.items.map((o) => o.metadata.name).sort();
  expect(names).toEqual(["b", "c"]);
  expect(
    result.current.items.find((o) => o.metadata.name === "b")?.metadata
      .resourceVersion,
  ).toBe("2");
});

test("objects_with_same_name_in_two_namespaces_stay_separate", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("web", "x"), pod("web", "y")));
  expect(result.current.items).toHaveLength(2);

  await subs[0].send({
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "x", name: "web" }],
  });
  expect(result.current.items.map((o) => o.metadata.namespace)).toEqual(["y"]);
});

test("cluster-scoped delete matches a null namespace", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot({ metadata: { name: "node-1" } }));
  await subs[0].send({
    type: "batch",
    upserts: [],
    deletes: [{ namespace: null, name: "node-1" }],
  });
  expect(result.current.items).toEqual([]);
});

test("clusters_do_not_share_rows", async () => {
  const { subs } = setup();
  const first = await mount("a");
  await subs[0].send(snapshot(pod("only-in-a")));
  const second = await mount("b");
  expect(subs).toHaveLength(2);
  await subs[1].send(snapshot(pod("only-in-b")));

  expect(first.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-a",
  ]);
  expect(second.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-b",
  ]);

  // A route change on one component from cluster a to b shows b's rows at once.
  first.rerender({ c: "b", r: pods });
  expect(first.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-b",
  ]);
  // Back on a, none of b's rows show while a's list loads again.
  first.rerender({ c: "a", r: pods });
  await act(flush);
  expect(first.result.current.items).toEqual([]);
  expect(first.result.current.loading).toBe(true);
  expect(subs[2].clusterId).toBe("a");
  await subs[2].send(snapshot(pod("only-in-a")));
  expect(first.result.current.items.map((o) => o.metadata.name)).toEqual([
    "only-in-a",
  ]);
});

/** Keeps the state of every render, including those before the effects run. */
function recordRenders(initial: string) {
  const renders: ResourceListState[] = [];
  const hook = renderHook(
    ({ c }: { c: string }) => {
      const state = useResourceList(c, pods);
      renders.push(state);
      return state;
    },
    { initialProps: { c: initial } },
  );
  return { renders, hook };
}

test("changing to a list nobody has open never renders the old rows", async () => {
  const { subs } = setup();
  const { renders, hook } = recordRenders("a");
  await act(flush);
  await subs[0].send(snapshot(pod("only-in-a")));
  renders.length = 0;

  hook.rerender({ c: "never-opened" });

  expect(renders.length).toBeGreaterThan(0);
  for (const state of renders) {
    expect(state.items).toEqual([]);
    expect(state.loading).toBe(true);
  }
});

test("the first render of a list is loading, not an empty list", async () => {
  setup();
  const { renders } = recordRenders("a");
  await act(flush);
  expect(renders[0].items).toEqual([]);
  expect(renders[0].loading).toBe(true);
});

test("two components share one subscription and unsubscribe on the last unmount", async () => {
  const { subs, backend } = setup();
  const one = await mount();
  const two = await mount();
  expect(subs).toHaveLength(1);
  expect(backend.callsTo("resources_subscribe")).toHaveLength(1);

  await subs[0].send(snapshot(pod("a")));
  expect(two.result.current.items).toHaveLength(1);

  one.unmount();
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([]);

  two.unmount();
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "sub-1" },
  ]);
});

test("a null resource subscribes to nothing", async () => {
  const { backend } = setup();
  const { result } = await mount("a", null);
  expect(result.current.items).toEqual([]);
  expect(result.current.loading).toBe(false);
  expect(backend.callsTo("resources_subscribe")).toEqual([]);
});

test("reconnecting keeps the last items and exposes the status", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("a")));
  await subs[0].send(status("live"));
  expect(result.current.status).toBe("live");

  await subs[0].send(status("reconnecting", "connection reset"));
  expect(result.current.status).toBe("reconnecting");
  expect(result.current.message).toBe("connection reset");
  expect(result.current.items).toHaveLength(1);
  expect(result.current.loading).toBe(false);
});

test("a new snapshot after a reconnect replaces stale items", async () => {
  const { subs } = setup();
  const { result } = await mount();
  await subs[0].send(snapshot(pod("old-1"), pod("old-2")));
  await subs[0].send(status("reconnecting"));
  await subs[0].send(snapshot(pod("new")));
  await subs[0].send(status("live"));
  expect(result.current.items.map((o) => o.metadata.name)).toEqual(["new"]);
  expect(result.current.message).toBeNull();
});

test("NotServed and Forbidden expose the message and stop showing loading", async () => {
  const { subs } = setup();
  const served = await mount("a");
  await subs[0].send(status("notServed", "the server has no pods"));
  expect(served.result.current.status).toBe("notServed");
  expect(served.result.current.message).toBe("the server has no pods");
  expect(served.result.current.loading).toBe(false);

  const denied = await mount("b");
  await subs[1].send(status("forbidden", "cannot list pods"));
  expect(denied.result.current.status).toBe("forbidden");
  expect(denied.result.current.message).toBe("cannot list pods");
  expect(denied.result.current.loading).toBe(false);
});

test("batches arriving together render in one update", async () => {
  const { subs } = setup();
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useResourceList("a", pods);
  });
  await act(flush);
  const before = renders;

  await subs[0].send({
    type: "batch",
    upserts: Array.from({ length: 200 }, (_, i) => pod(`p${i}`)),
    deletes: Array.from({ length: 50 }, (_, i) => ({
      namespace: "default",
      name: `gone${i}`,
    })),
  });
  expect(hook.result.current.items).toHaveLength(200);
  expect(renders - before).toBeLessThanOrEqual(1);
});

test("a subscribe that fails shows the message and stops loading", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "InvalidInput", message: "cluster a is disconnected" };
    },
  });
  const { result } = await mount();
  expect(result.current.loading).toBe(false);
  expect(result.current.status).toBe("notServed");
  expect(result.current.message).toBe("cluster a is disconnected");
});

test("a subscribe refused as forbidden reports forbidden", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "Forbidden", message: "pods is forbidden" };
    },
  });
  const { result } = await mount();
  expect(result.current.loading).toBe(false);
  expect(result.current.status).toBe("forbidden");
  expect(result.current.message).toBe("pods is forbidden");
});

test("unmounting before the subscription id arrives still unsubscribes", async () => {
  let release: (id: string) => void = () => {};
  const backend = mockBackend({
    resources_subscribe: () => new Promise<string>((r) => (release = r)),
    resources_unsubscribe: () => null,
  });
  const hook = await mount();
  hook.unmount();
  release("late");
  await act(flush);
  expect(backend.callsTo("resources_unsubscribe")).toEqual([
    { subscriptionId: "late" },
  ]);
});

test("findResource matches group and plural", () => {
  const info = (group: string, plural: string) => ({
    resource: { ...pods, group, plural },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  });
  const all = [info("", "pods"), info("apps", "deployments")];
  expect(findResource(all, "apps", "deployments")).toBe(all[1]);
  expect(findResource(all, "apps", "pods")).toBeUndefined();
});

test("useApiResources discovers and refreshes", async () => {
  let calls = 0;
  const backend = mockBackend({
    resources_discover: () => {
      calls += 1;
      return [];
    },
  });
  const { result } = renderHook(() => useApiResources("a"));
  expect(result.current.loading).toBe(true);
  await act(flush);
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBeNull();
  await act(() => result.current.refresh());
  expect(calls).toBe(2);
  expect(backend.callsTo("resources_discover")).toEqual([
    { clusterId: "a", refresh: false },
    { clusterId: "a", refresh: true },
  ]);
});

test("useApiResources reports a failure", async () => {
  mockBackend({
    resources_discover: () => {
      throw { code: "InvalidInput", message: "cluster a is disconnected" };
    },
  });
  const { result } = renderHook(() => useApiResources("a"));
  await act(flush);
  expect(result.current.error).toBe("cluster a is disconnected");
  expect(result.current.loading).toBe(false);
});
