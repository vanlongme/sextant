import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { DrawerTarget } from "../../kinds/detail/links";
import type { KubeObject } from "../../kinds/objects";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { useDrawerObject } from "./useDrawerObject";

function info(plural: string, kind: string, canList = true): ApiResourceInfo {
  return {
    resource: { group: "", version: "v1", plural, kind, namespaced: true },
    verbs: [],
    shortNames: [],
    canList,
    canWatch: canList,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

const CONFIGMAPS = info("configmaps", "ConfigMap");
const PODS = info("pods", "Pod");
const TARGET: DrawerTarget = {
  group: "",
  plural: "configmaps",
  namespace: "n",
  name: "app",
};
const object = (name: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  metadata: { name, namespace: "n", resourceVersion: "1" },
  ...extra,
});

type Get = (a: { name: string }) => unknown;

function backend(opts: { get?: Get; subscribe?: () => unknown } = {}) {
  let send: (e: WatchEvent) => void = () => {};
  const b = mockBackend({
    resources_subscribe:
      opts.subscribe ??
      ((a: { onEvent: { onmessage: (e: WatchEvent) => void } }) => {
        send = a.onEvent.onmessage;
        return "sub";
      }),
    resources_unsubscribe: () => null,
    resource_get:
      opts.get ??
      (() => {
        throw { code: "NotFound", message: "not found" };
      }),
  });
  const snapshot = (items: KubeObject[]) =>
    act(async () => {
      send({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  return { b, snapshot };
}

const read = (
  i: ApiResourceInfo | undefined,
  target: DrawerTarget | null = TARGET,
  lastSeen: KubeObject | null = null,
) => renderHook(() => useDrawerObject("c1", i, target, lastSeen));

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("no target is loading and a kind the cluster does not serve is notServed", async () => {
  backend();
  expect(read(CONFIGMAPS, null).result.current.status).toBe("loading");
  const { result } = read(undefined);
  await act(flush);
  expect(result.current).toMatchObject({ status: "notServed", object: null });
});

test("a listed object is live from the shared list, and loading until the list syncs", async () => {
  const { b, snapshot } = backend();
  const { result } = read(CONFIGMAPS);
  await act(flush);
  expect(result.current.status).toBe("loading");
  await snapshot([object("app")]);
  expect(result.current.status).toBe("live");
  expect(result.current.object?.metadata.name).toBe("app");
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test("a listed object that goes away is deleted when one was seen, with no get", async () => {
  const { b, snapshot } = backend();
  const { result } = read(CONFIGMAPS, TARGET, object("app"));
  await act(flush);
  await snapshot([]);
  expect(result.current).toMatchObject({ status: "deleted" });
  expect(result.current.object?.metadata.name).toBe("app");
  expect(b.callsTo("resource_get")).toHaveLength(0);
});

test("an object the synced list lacks is confirmed with one get", async () => {
  const { b, snapshot } = backend({ get: () => object("app") });
  const { result } = read(CONFIGMAPS);
  await act(flush);
  await snapshot([]);
  await act(flush);
  expect(result.current.status).toBe("fetched");
  expect(b.callsTo("resource_get")).toEqual([
    {
      clusterId: "c1",
      resource: CONFIGMAPS.resource,
      namespace: "n",
      name: "app",
    },
  ]);
});

test.each([
  ["NotFound", "notFound"],
  ["Forbidden", "forbidden"],
  ["Unauthorized", "forbidden"],
  ["Unreachable", "error"],
])("a get failing with %s gives %s", async (code, status) => {
  const { snapshot } = backend({
    get: () => {
      throw { code, message: `${code} message` };
    },
  });
  const { result } = read(CONFIGMAPS);
  await act(flush);
  await snapshot([]);
  await act(flush);
  expect(result.current.status).toBe(status);
  if (status !== "notFound") {
    expect(result.current.message).toBe(`${code} message`);
  }
});

test("without list access there is no watch, one get, and Retry gets again", async () => {
  let fail = true;
  const { b } = backend({
    get: () => {
      if (fail) throw { code: "Internal", message: "boom" };
      return object("app");
    },
  });
  const { result } = read(info("configmaps", "ConfigMap", false));
  await act(flush);
  expect(b.callsTo("resources_subscribe")).toHaveLength(0);
  expect(result.current).toMatchObject({ status: "error", message: "boom" });
  fail = false;
  act(() => result.current.retry());
  expect(result.current.status).toBe("loading");
  await act(flush);
  expect(result.current.status).toBe("fetched");
  expect(b.callsTo("resource_get")).toHaveLength(2);
});

test("a list the user may not watch falls back to a get", async () => {
  backend({
    subscribe: () => {
      throw { code: "Forbidden", message: "configmaps is forbidden" };
    },
    get: () => object("app"),
  });
  const { result } = read(CONFIGMAPS);
  await act(flush);
  await act(flush);
  expect(result.current.status).toBe("fetched");
});

test("a list the cluster does not serve is notServed with the list's message", async () => {
  backend({
    subscribe: () => {
      throw {
        code: "Internal",
        message: "the server could not find the requested resource",
      };
    },
  });
  const { result } = read(CONFIGMAPS);
  await act(flush);
  await act(flush);
  expect(result.current).toMatchObject({
    status: "notServed",
    message: "the server could not find the requested resource",
  });
});

test("a trimmed Pod row is live with the whole object from a get", async () => {
  const whole = object("web", { spec: { nodeName: "n1" } });
  const { b, snapshot } = backend({ get: () => whole });
  const { result } = read(PODS, {
    group: "",
    plural: "pods",
    namespace: "n",
    name: "web",
  });
  await act(flush);
  await snapshot([object("web")]);
  await act(flush);
  expect(result.current.status).toBe("live");
  expect(result.current.object).toEqual(whole);
  expect(b.callsTo("resource_get")).toHaveLength(1);
});
