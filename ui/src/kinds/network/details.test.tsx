import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { ENDPOINT_SLICES } from "../refs";
import { EndpointSliceDetail } from "./EndpointSliceDetail";
import { IngressClassDetail } from "./IngressClassDetail";
import { IngressDetail } from "./IngressDetail";
import { NetworkPolicyDetail } from "./NetworkPolicyDetail";
import { ServiceDetail } from "./ServiceDetail";

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

const ref = (group: string, plural: string, kind: string): ResourceRef => ({
  group,
  version: "v1",
  plural,
  kind,
  namespaced: true,
});
const info = (r: ResourceRef) =>
  ({ resource: r }) as unknown as ApiResourceInfo;

function show(
  Detail: typeof ServiceDetail,
  object: KubeObject,
  resource: ResourceRef,
) {
  render(
    <MemoryRouter>
      <Detail
        clusterId="c"
        object={object}
        resource={resource}
        resources={[info(resource), info(ref("", "pods", "Pod"))]}
      />
    </MemoryRouter>,
  );
}

const SERVICES = ref("", "services", "Service");

test("a service shows its own endpoints only", async () => {
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
  show(
    ServiceDetail,
    {
      metadata: { name: "web", namespace: "d" },
      spec: {
        type: "ClusterIP",
        clusterIP: "10.0.0.5",
        selector: { app: "web" },
        ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
      },
    },
    SERVICES,
  );
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        {
          metadata: {
            name: "web-a",
            namespace: "d",
            labels: { "kubernetes.io/service-name": "web" },
          },
          endpoints: [
            {
              addresses: ["1.1.1.1"],
              conditions: { ready: true },
              nodeName: "n1",
              targetRef: { kind: "Pod", name: "web-1", namespace: "d" },
            },
          ],
        },
        {
          metadata: {
            name: "other-a",
            namespace: "d",
            labels: { "kubernetes.io/service-name": "other" },
          },
          endpoints: [{ addresses: ["9.9.9.9"] }],
        },
        {
          metadata: {
            name: "web-b",
            namespace: "elsewhere",
            labels: { "kubernetes.io/service-name": "web" },
          },
          endpoints: [{ addresses: ["8.8.8.8"] }],
        },
      ],
    } as WatchEvent);
    await flush();
  });
  expect(screen.getByText("10.0.0.5")).toBeTruthy();
  expect(screen.getByText("app=web")).toBeTruthy();
  const ports = within(screen.getByTestId("detail-service-ports"));
  expect(ports.getByText("8080")).toBeTruthy();
  const eps = within(screen.getByTestId("detail-service-endpoints"));
  expect(eps.getByText("1.1.1.1")).toBeTruthy();
  expect(eps.getByText("n1")).toBeTruthy();
  expect(eps.getByText("Pod web-1")).toBeTruthy();
  expect(screen.queryByText("9.9.9.9")).toBeNull();
  expect(screen.queryByText("8.8.8.8")).toBeNull();
});

test("a service without a selector has no chips", () => {
  mockBackend({
    resources_subscribe: () => "s",
    resources_unsubscribe: () => null,
  });
  show(
    ServiceDetail,
    { metadata: { name: "web", namespace: "d" }, spec: { selector: {} } },
    SERVICES,
  );
  expect(screen.queryByText("Selector")).toBeNull();
});

test("a forbidden slice list says so rather than showing an empty table", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "Forbidden", message: "endpointslices is forbidden" };
    },
    resources_unsubscribe: () => null,
  });
  show(
    ServiceDetail,
    { metadata: { name: "web", namespace: "d" }, spec: {} },
    SERVICES,
  );
  await act(flush);
  expect(screen.getByRole("alert").textContent).toContain(
    "endpointslices is forbidden",
  );
  expect(screen.queryByTestId("detail-service-endpoints")).toBeNull();
});

test("an ingress shows rules, TLS and the default backend", () => {
  show(
    IngressDetail,
    {
      metadata: { name: "i", namespace: "d" },
      spec: {
        ingressClassName: "nginx",
        defaultBackend: {
          service: { name: "fallback", port: { number: 8080 } },
        },
        tls: [{ hosts: ["a.example"], secretName: "cert" }],
        rules: [
          {
            host: "a.example",
            http: {
              paths: [
                {
                  path: "/x",
                  pathType: "Prefix",
                  backend: { service: { name: "s", port: { number: 80 } } },
                },
              ],
            },
          },
        ],
      },
    },
    ref("networking.k8s.io", "ingresses", "Ingress"),
  );
  const rules = within(screen.getByTestId("detail-ingress-rules"));
  expect(rules.getByText("a.example")).toBeTruthy();
  expect(rules.getByText("s:80")).toBeTruthy();
  expect(screen.getByText("cert")).toBeTruthy();
  expect(screen.getByText("fallback:8080")).toBeTruthy();
});

const POLICIES = ref("networking.k8s.io", "networkpolicies", "NetworkPolicy");

test("a network policy reads in words", () => {
  show(
    NetworkPolicyDetail,
    {
      metadata: { name: "p", namespace: "d" },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [{}],
      },
    },
    POLICIES,
  );
  expect(screen.getByText("All pods in this namespace")).toBeTruthy();
  expect(screen.getByText("Allows all ingress")).toBeTruthy();
  expect(screen.getByText("Denies all egress")).toBeTruthy();
});

test("a network policy with no ingress list denies all ingress", () => {
  show(
    NetworkPolicyDetail,
    {
      metadata: { name: "p", namespace: "d" },
      spec: {
        podSelector: { matchLabels: { a: "1" } },
        policyTypes: ["Ingress"],
      },
    },
    POLICIES,
  );
  expect(screen.getByText("Denies all ingress")).toBeTruthy();
  expect(screen.queryByText(/egress/i)).toBeNull();
});

test("a network policy lists ports and peers", () => {
  show(
    NetworkPolicyDetail,
    {
      metadata: { name: "p", namespace: "d" },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ ipBlock: { cidr: "10.0.0.0/8" } }],
            ports: [{ port: 80 }],
          },
        ],
      },
    },
    POLICIES,
  );
  expect(screen.getByText("CIDR 10.0.0.0/8")).toBeTruthy();
  expect(screen.getByText("TCP 80")).toBeTruthy();
});

test("an endpoint slice shows address, ready, node and target", () => {
  show(
    EndpointSliceDetail,
    {
      metadata: { name: "s", namespace: "d" },
      addressType: "IPv4",
      ports: [{ port: 80 }],
      endpoints: [
        {
          addresses: ["1.1.1.1"],
          conditions: { ready: false },
          nodeName: "n1",
          targetRef: { kind: "Pod", name: "p1", namespace: "d" },
        },
      ],
    },
    ENDPOINT_SLICES,
  );
  expect(screen.getByText("1.1.1.1")).toBeTruthy();
  expect(screen.getByText("No")).toBeTruthy();
  expect(screen.getByText("n1")).toBeTruthy();
  expect(screen.getByText("Pod p1")).toBeTruthy();
});

test("an ingress class shows controller, parameters and default", () => {
  show(
    IngressClassDetail,
    {
      metadata: {
        name: "nginx",
        annotations: { "ingressclass.kubernetes.io/is-default-class": "true" },
      },
      spec: {
        controller: "k8s.io/ingress-nginx",
        parameters: { kind: "Params", name: "p1", apiGroup: "example.io" },
      },
    },
    ref("networking.k8s.io", "ingressclasses", "IngressClass"),
  );
  expect(screen.getByText("k8s.io/ingress-nginx")).toBeTruthy();
  expect(screen.getByText("Params/p1")).toBeTruthy();
  expect(screen.getByText("Yes")).toBeTruthy();
});
