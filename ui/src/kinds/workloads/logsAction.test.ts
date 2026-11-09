import { ScrollText } from "lucide-react";
import { afterEach, expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { newCreateTab, resetDockForTest, useDock } from "../../stores/dock";
import type { KubeObject } from "../objects";
import { DEPLOYMENTS, PODS } from "../refs";
import { type ActionContext, kindSpec } from "../registry";
import "./index";
import { podLogsAction, workloadLogsAction } from "./logsAction";

afterEach(() => resetDockForTest());

function context(resource: ResourceRef): ActionContext {
  return {
    clusterId: "c1",
    resource,
    navigate: () => {},
    confirm: async () => true,
    openEditor: () => {},
    dialog: () => {},
  };
}

const POD: KubeObject = {
  metadata: { name: "web-7d9f-abcde", namespace: "shop" },
  spec: { containers: [{ name: "app" }, { name: "proxy" }] },
};

const DEPLOYMENT: KubeObject = {
  metadata: { name: "web", namespace: "shop" },
  spec: { template: { spec: { containers: [{ name: "app" }] } } },
};

test.each<[string, string, string]>([
  ["", "pods", "Logs"],
  ["apps", "deployments", "Logs of all Pods"],
  ["apps", "statefulsets", "Logs of all Pods"],
  ["apps", "daemonsets", "Logs of all Pods"],
  ["apps", "replicasets", "Logs of all Pods"],
  ["batch", "jobs", "Logs of all Pods"],
])("%s/%s offers %s first", (group, plural, label) => {
  const first = kindSpec(group, plural)?.actions?.[0];
  expect(first).toMatchObject({ id: "logs", label, top: true });
  expect(first?.icon).toBe(ScrollText);
  expect(first?.requires).toBeUndefined();
  expect(first?.danger).toBeUndefined();
});

test("Logs on a Pod opens a tab on its first container and shows it", () => {
  useDock.getState().setMinimized(true);
  podLogsAction.run(context(PODS), POD);
  const { tabs, activeId, minimized } = useDock.getState();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({
    id: "logs:c1:/pods:shop/web-7d9f-abcde",
    kind: "logs",
    title: "Logs · web-7d9f-abcde",
    options: { pod: "all", container: "app", tail: 1000, follow: true },
  });
  expect(activeId).toBe(tabs[0]?.id);
  expect(minimized).toBe(false);
});

test("Logs of all Pods reads every container", () => {
  workloadLogsAction.run(context(DEPLOYMENTS), DEPLOYMENT);
  expect(useDock.getState().tabs[0]).toMatchObject({
    id: "logs:c1:apps/deployments:shop/web",
    title: "Logs · web",
    options: { pod: "all", container: null },
  });
});

test("opening Logs again focuses its tab and keeps its options", () => {
  podLogsAction.run(context(PODS), POD);
  const id = useDock.getState().tabs[0]?.id ?? "";
  useDock.getState().setLogOptions(id, { tail: 100, wrap: true });
  useDock.getState().open(newCreateTab("c1"));
  podLogsAction.run(context(PODS), POD);
  const { tabs, activeId } = useDock.getState();
  expect(tabs.filter((t) => t.kind === "logs")).toHaveLength(1);
  expect(activeId).toBe(id);
  expect(tabs[0]).toMatchObject({ options: { tail: 100, wrap: true } });
});
