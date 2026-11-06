import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { CrdDetail, EventDetail, NamespaceDetail } from "./ClusterDetails";

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

const ref = (
  plural: string,
  kind: string,
  namespaced: boolean,
): ResourceRef => ({
  group: "",
  version: "v1",
  plural,
  kind,
  namespaced,
});
const info = (r: ResourceRef) =>
  ({ resource: r }) as unknown as ApiResourceInfo;

function show(Detail: typeof NamespaceDetail, object: KubeObject) {
  render(
    <MemoryRouter>
      <Detail
        clusterId="c"
        object={object}
        resource={ref("x", "X", false)}
        resources={[info(ref("pods", "Pod", true))]}
      />
    </MemoryRouter>,
  );
}

const quota = (
  name: string,
  namespace: string,
  hard: string,
  used: string,
) => ({
  metadata: { name, namespace },
  status: { hard: { pods: hard }, used: { pods: used } },
});

test("a namespace sums up the quotas of its own namespace only", async () => {
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
  show(NamespaceDetail, {
    metadata: { name: "team" },
    status: { phase: "Active" },
  });
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        quota("q", "team", "10", "3"),
        quota("o", "elsewhere", "99", "98"),
      ],
    } as WatchEvent);
    await flush();
  });
  expect(screen.getByText("Active")).toBeTruthy();
  const table = within(screen.getByTestId("detail-quota-summary"));
  expect(table.getByText("10")).toBeTruthy();
  expect(table.queryByText("99")).toBeNull();
});

test("a forbidden quota list shows the API's message", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "Forbidden", message: "resourcequotas is forbidden" };
    },
    resources_unsubscribe: () => null,
  });
  show(NamespaceDetail, { metadata: { name: "team" } });
  await act(flush);
  expect(screen.getByText("resourcequotas is forbidden")).toBeTruthy();
});

test("none of the quotas in the list gives No quotas.", async () => {
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
  show(NamespaceDetail, { metadata: { name: "team" } });
  await act(async () => {
    send({
      type: "snapshot",
      items: [quota("o", "elsewhere", "9", "1")],
    } as WatchEvent);
    await flush();
  });
  expect(screen.getByText("No quotas.")).toBeTruthy();
});

test("an event shows its object, reason, count, source and times", () => {
  show(EventDetail, {
    metadata: { name: "e", namespace: "d" },
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting",
    count: 7,
    source: { component: "kubelet", host: "n1" },
    involvedObject: {
      kind: "Pod",
      name: "web-1",
      namespace: "d",
      apiVersion: "v1",
    },
    firstTimestamp: "2026-01-01T00:00:00Z",
    lastTimestamp: "2026-01-02T00:00:00Z",
  });
  expect(screen.getByRole("link", { name: "Pod web-1" })).toBeTruthy();
  expect(screen.getByText("BackOff")).toBeTruthy();
  expect(screen.getByText("7")).toBeTruthy();
  expect(screen.getByText("kubelet on n1")).toBeTruthy();
  expect(screen.getByText("Back-off restarting")).toBeTruthy();
  expect(screen.getByText("2026-01-01T00:00:00Z")).toBeTruthy();
  expect(screen.getByText("2026-01-02T00:00:00Z")).toBeTruthy();
});

const crd = (schema?: unknown): KubeObject => ({
  metadata: { name: "widgets.example.com" },
  spec: {
    group: "example.com",
    scope: "Namespaced",
    names: { kind: "Widget", plural: "widgets", shortNames: ["wd"] },
    versions: [
      {
        name: "v1alpha1",
        served: true,
        storage: false,
        additionalPrinterColumns: [
          { name: "Old", type: "string", jsonPath: ".a" },
        ],
      },
      {
        name: "v1",
        served: true,
        storage: true,
        additionalPrinterColumns: [
          { name: "Size", type: "integer", jsonPath: ".spec.size" },
        ],
        schema: schema === undefined ? undefined : { openAPIV3Schema: schema },
      },
    ],
  },
});

test("a CRD shows its versions, preferred printer columns and schema", () => {
  show(CrdDetail, crd({ type: "object", description: "A widget" }));
  expect(screen.getByText("example.com")).toBeTruthy();
  expect(screen.getByText("Namespaced")).toBeTruthy();
  expect(screen.getByText("wd")).toBeTruthy();
  const versions = within(screen.getByTestId("detail-crd-versions"));
  expect(versions.getByText("v1alpha1")).toBeTruthy();
  const columns = within(screen.getByTestId("detail-crd-columns"));
  expect(columns.getByText("Size")).toBeTruthy();
  expect(columns.queryByText("Old")).toBeNull();
  const schema = within(screen.getByTestId("detail-crd-schema"));
  expect(schema.getByTestId("detail-fields")).toBeTruthy();
  expect(schema.queryByText("No schema.")).toBeNull();
});

test("a CRD without a schema says so", () => {
  show(CrdDetail, crd());
  expect(
    within(screen.getByTestId("detail-crd-schema")).getByText("No schema."),
  ).toBeTruthy();
});
