import { expect, test } from "vitest";
import {
  ingressAddress,
  ingressHosts,
  ingressPorts,
  ingressRoutes,
  policyPeerText,
  policyPortText,
  serviceExternalIp,
  servicePorts,
  serviceStatus,
  sliceEndpoints,
  slicePorts,
} from "./network";

const m = { name: "x" };
const svc = (spec: object, status: object = {}) => ({
  metadata: m,
  spec,
  status,
});

test("service ports read like kubectl", () => {
  expect(
    servicePorts(
      svc({
        ports: [
          { port: 80, protocol: "TCP" },
          { port: 443, nodePort: 30443, protocol: "TCP" },
        ],
      }),
    ),
  ).toBe("80/TCP,443:30443/TCP");
  expect(servicePorts(svc({}))).toBe("");
});

test.each([
  ["cluster IP", svc({ type: "ClusterIP" }), "<none>"],
  [
    "cluster IP with external IPs",
    svc({ type: "ClusterIP", externalIPs: ["1.1.1.1"] }),
    "1.1.1.1",
  ],
  ["node port", svc({ type: "NodePort" }), "<none>"],
  ["load balancer pending", svc({ type: "LoadBalancer" }), "<pending>"],
  [
    "load balancer with an empty list is pending",
    svc({ type: "LoadBalancer" }, { loadBalancer: { ingress: [] } }),
    "<pending>",
  ],
  [
    "load balancer IP and hostname",
    svc(
      { type: "LoadBalancer" },
      { loadBalancer: { ingress: [{ ip: "2.2.2.2" }, { hostname: "h" }] } },
    ),
    "2.2.2.2,h",
  ],
  [
    "load balancer plus external IPs",
    svc(
      { type: "LoadBalancer", externalIPs: ["1.1.1.1"] },
      { loadBalancer: { ingress: [{ ip: "2.2.2.2" }] } },
    ),
    "2.2.2.2,1.1.1.1",
  ],
  [
    "external name",
    svc({ type: "ExternalName", externalName: "db.example" }),
    "db.example",
  ],
  ["no type means cluster IP", svc({}), "<none>"],
])("external IP: %s", (_n, object, expected) => {
  expect(serviceExternalIp(object)).toBe(expected);
});

test("service status is pending only for a load balancer with no address", () => {
  expect(serviceStatus(svc({ type: "LoadBalancer" }))).toEqual({
    label: "Pending",
    tone: "warn",
  });
  expect(serviceStatus(svc({ type: "ClusterIP" }))).toEqual({
    label: "Active",
    tone: "ok",
  });
  expect(
    serviceStatus(
      svc(
        { type: "LoadBalancer" },
        { loadBalancer: { ingress: [{ ip: "2.2.2.2" }] } },
      ),
    ),
  ).toEqual({ label: "Active", tone: "ok" });
});

const ingress = {
  metadata: m,
  spec: {
    tls: [{ hosts: ["a.example"], secretName: "t" }],
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
      {
        http: {
          paths: [
            { backend: { service: { name: "d", port: { name: "web" } } } },
          ],
        },
      },
    ],
  },
  status: {
    loadBalancer: { ingress: [{ hostname: "lb" }, { ip: "3.3.3.3" }] },
  },
};

test("ingress reads", () => {
  // As kubectl: rules with no host are left out, and `*` stands for none at all.
  expect(ingressHosts(ingress)).toBe("a.example");
  expect(ingressHosts({ metadata: m, spec: { rules: [{ http: {} }] } })).toBe(
    "*",
  );
  expect(ingressHosts({ metadata: m })).toBe("*");
  expect(ingressPorts(ingress)).toBe("80, 443");
  expect(ingressPorts({ metadata: m, spec: {} })).toBe("80");
  expect(ingressAddress(ingress)).toBe("lb,3.3.3.3");
  expect(ingressRoutes(ingress)).toEqual([
    { host: "a.example", path: "/x", pathType: "Prefix", backend: "s:80" },
    { host: "*", path: "/", pathType: "", backend: "d:web" },
  ]);
  expect(ingressRoutes({ metadata: m })).toEqual([]);
});

test("endpoint slices", () => {
  const slice = {
    metadata: m,
    ports: [{ port: 80 }, { port: 53, protocol: "UDP" }],
    endpoints: [
      { addresses: ["1.1.1.1", "1.1.1.2"] },
      { addresses: ["1.1.1.3"] },
    ],
  };
  expect(slicePorts(slice)).toBe("80/TCP,53/UDP");
  expect(sliceEndpoints(slice)).toBe("1.1.1.1,1.1.1.2,1.1.1.3");
  expect(slicePorts({ metadata: m })).toBe("");
});

test("network policy peers and ports", () => {
  expect(
    policyPeerText({
      ipBlock: { cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] },
    }),
  ).toBe("CIDR 10.0.0.0/8 except 10.1.0.0/16");
  expect(policyPeerText({ podSelector: { matchLabels: { a: "1" } } })).toBe(
    "pods a=1 in this namespace",
  );
  expect(policyPeerText({ podSelector: {} })).toBe(
    "all pods in this namespace",
  );
  expect(policyPeerText({ namespaceSelector: {} })).toBe(
    "all pods in all namespaces",
  );
  expect(
    policyPeerText({ namespaceSelector: { matchLabels: { t: "x" } } }),
  ).toBe("all pods in namespaces t=x");
  expect(
    policyPeerText({
      namespaceSelector: { matchLabels: { t: "x" } },
      podSelector: { matchLabels: { a: "1" } },
    }),
  ).toBe("pods a=1 in namespaces t=x");
  expect(policyPortText({ protocol: "UDP", port: 53 })).toBe("UDP 53");
  expect(policyPortText({ port: 80, endPort: 90 })).toBe("TCP 80-90");
  expect(policyPortText({})).toBe("TCP all ports");
});
