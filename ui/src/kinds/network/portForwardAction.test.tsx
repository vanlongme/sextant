import { render, screen } from "@testing-library/react";
import { ArrowRightLeft } from "lucide-react";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../objects";
import { PODS } from "../refs";
import { type ActionContext, type KindAction, kindSpec } from "../registry";
import "../workloads/index";
import "./index";
import {
  portForwardAction,
  servicePortForwardAction,
} from "./portForwardAction";

const SERVICES: ResourceRef = {
  group: "",
  version: "v1",
  plural: "services",
  kind: "Service",
  namespaced: true,
};

function context(resource: ResourceRef, shown: ReactNode[]): ActionContext {
  return {
    clusterId: "c1",
    resource,
    navigate: () => {},
    confirm: async () => false,
    openEditor: () => {},
    dialog: (render) => {
      shown.push(render(() => {}));
    },
  };
}

test("Pods offer Port forward after Attach, without a header button", () => {
  expect(kindSpec("", "pods")?.actions?.map((a) => a.id)).toEqual([
    "logs",
    "shell",
    "attach",
    "portForward",
    "evict",
    "force-delete",
  ]);
  expect(kindSpec("", "pods")?.actions?.[3]).toBe(portForwardAction);
  expect(portForwardAction).toMatchObject({
    id: "portForward",
    label: "Port forward",
  });
  expect(portForwardAction.icon).toBe(ArrowRightLeft);
  expect(portForwardAction.top).toBeUndefined();
  expect(portForwardAction.requires).toBeUndefined();
});

test("Port forward is the only action on Services, with a header button", () => {
  expect(kindSpec("", "services")?.actions).toEqual([servicePortForwardAction]);
  expect(servicePortForwardAction).toMatchObject({
    id: "portForward",
    label: "Port forward",
    top: true,
  });
  expect(servicePortForwardAction.icon).toBe(ArrowRightLeft);
  expect(servicePortForwardAction.requires).toBeUndefined();
});

test.each<[string, KindAction, ResourceRef, KubeObject, string, string]>([
  [
    "Pod",
    portForwardAction,
    PODS,
    {
      metadata: { name: "web-1", namespace: "shop" },
      spec: {
        containers: [
          {
            name: "app",
            ports: [
              { name: "http", containerPort: 8080 },
              { containerPort: 9090 },
            ],
          },
        ],
      },
    },
    "Port forward pod/web-1",
    "8080/TCP · http",
  ],
  [
    "Service",
    servicePortForwardAction,
    SERVICES,
    {
      metadata: { name: "web", namespace: "shop" },
      spec: { ports: [{ port: 8443 }, { name: "http", port: 80 }] },
    },
    "Port forward service/web",
    "8443/TCP",
  ],
])(
  "on a %s, run opens the start dialog on the first port",
  async (_, action, resource, object, title, chosen) => {
    const shown: ReactNode[] = [];
    await action.run(context(resource, shown), object);
    expect(shown).toHaveLength(1);
    render(shown[0]);
    expect(screen.getByTestId("pf-dialog")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
    expect(screen.getByTestId("pf-target-port").textContent).toBe(chosen);
  },
);
