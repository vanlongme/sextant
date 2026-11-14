import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { OverviewSections } from "../../features/details/OverviewSections";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { DEPLOYMENTS } from "../refs";
import { kindSpec } from "../registry";
import { RolloutDetail } from "./RolloutDetail";
import "./index";

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("shows replicas, selector, strategy and the pods it owns", async () => {
  let send: (e: WatchEvent) => void = () => {};
  mockBackend({
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub";
    },
    resources_unsubscribe: () => null,
  });
  const object = {
    metadata: { name: "web", namespace: "n" },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: "web" } },
      strategy: {
        type: "RollingUpdate",
        rollingUpdate: { maxSurge: "25%", maxUnavailable: 1 },
      },
    },
    status: { updatedReplicas: 1, readyReplicas: 2, availableReplicas: 2 },
  };
  render(
    <MemoryRouter>
      <RolloutDetail
        clusterId="c"
        object={object}
        resource={DEPLOYMENTS}
        resources={[]}
      />
    </MemoryRouter>,
  );
  await act(flush);
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        { metadata: { name: "mine", namespace: "n", labels: { app: "web" } } },
        {
          metadata: {
            name: "other-ns",
            namespace: "m",
            labels: { app: "web" },
          },
        },
        { metadata: { name: "unlabelled", namespace: "n" } },
      ],
    } as WatchEvent);
    await flush();
  });
  expect(
    screen.getByText("2 desired, 1 updated, 2 ready, 2 available"),
  ).toBeTruthy();
  expect(screen.getByText("app=web")).toBeTruthy();
  expect(
    screen.getByText("RollingUpdate maxSurge=25% maxUnavailable=1"),
  ).toBeTruthy();
  const pods = within(screen.getByTestId("detail-pods"));
  expect(pods.getByText("mine")).toBeTruthy();
  expect(pods.queryByText("other-ns")).toBeNull();
  expect(pods.queryByText("unlabelled")).toBeNull();
});

const STATEFULSETS: ResourceRef = {
  group: "apps",
  version: "v1",
  plural: "statefulsets",
  kind: "StatefulSet",
  namespaced: true,
};

function served(resource: ResourceRef): ApiResourceInfo {
  return {
    resource,
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

const SERVED = [
  served(DEPLOYMENTS),
  served(STATEFULSETS),
  served({
    group: "",
    version: "v1",
    plural: "namespaces",
    kind: "Namespace",
    namespaced: false,
  }),
  served({
    group: "",
    version: "v1",
    plural: "serviceaccounts",
    kind: "ServiceAccount",
    namespaced: true,
  }),
  served({
    group: "",
    version: "v1",
    plural: "configmaps",
    kind: "ConfigMap",
    namespaced: true,
  }),
];

async function overview(resource: ResourceRef, object: KubeObject) {
  let send: (e: WatchEvent) => void = () => {};
  mockBackend({
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub";
    },
    resources_unsubscribe: () => null,
  });
  const columns =
    kindSpec(resource.group, resource.plural)?.columns?.(served(resource)) ??
    [];
  render(
    <MemoryRouter>
      <OverviewSections
        clusterId="c"
        resource={resource}
        object={object}
        resources={SERVED}
        columns={columns}
      />
    </MemoryRouter>,
  );
  await act(flush);
  await act(async () => {
    send({ type: "snapshot", items: [] } as WatchEvent);
    await flush();
  });
}

test("a Deployment's Overview lists its template's volumes, no controller and the default service account", async () => {
  await overview(DEPLOYMENTS, {
    metadata: { name: "web", namespace: "n" },
    spec: {
      selector: { matchLabels: { app: "web" } },
      template: {
        spec: {
          volumes: [{ name: "config", configMap: { name: "settings" } }],
          containers: [
            {
              name: "app",
              volumeMounts: [
                { name: "config", mountPath: "/etc/app", readOnly: true },
              ],
            },
          ],
        },
      },
    },
  });
  const volume = within(screen.getByTestId("detail-volume-config"));
  expect(volume.getByText("ConfigMap")).toBeTruthy();
  expect(volume.getByRole("link", { name: "settings" })).toBeTruthy();
  expect(volume.getByTitle("/etc/app").textContent).toBe("app → /​etc/​app, ro");
  const relations = within(screen.getByTestId("detail-relations"));
  expect(relations.getByRole("link", { name: "n" })).toBeTruthy();
  expect(relations.getByText("None")).toBeTruthy();
  expect(relations.getByRole("link", { name: "default" })).toBeTruthy();
  // The kind's own parts stay, inside the card style (spec H40).
  expect(screen.getByTestId("detail-pods")).toBeTruthy();
});

test("a StatefulSet lists each claim template as a volume after the template's own", async () => {
  await overview(STATEFULSETS, {
    metadata: { name: "db", namespace: "n" },
    spec: {
      selector: { matchLabels: { app: "db" } },
      template: {
        spec: {
          serviceAccountName: "db-runner",
          volumes: [{ name: "config", configMap: { name: "db-config" } }],
          containers: [
            {
              name: "db",
              volumeMounts: [
                { name: "config", mountPath: "/etc/db" },
                { name: "data", mountPath: "/var/lib/db" },
              ],
            },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            storageClassName: "fast",
            resources: { requests: { storage: "1Gi" } },
          },
        },
      ],
    },
  });
  expect(
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="detail-volume-"]',
      ),
    ].map((el) => el.dataset.testid),
  ).toEqual(["detail-volume-config", "detail-volume-data"]);
  const data = within(screen.getByTestId("detail-volume-data"));
  expect(data.getByText("Claim template")).toBeTruthy();
  expect(data.getByText("One claim per Pod, fast, 1Gi")).toBeTruthy();
  expect(data.getByTitle("/var/lib/db").textContent).toBe("db → /​var/​lib/​db");
  expect(
    within(screen.getByTestId("detail-relations")).getByRole("link", {
      name: "db-runner",
    }),
  ).toBeTruthy();
});
