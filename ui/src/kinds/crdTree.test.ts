import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import { baseDomain, crdTree } from "./crdTree";

function info(
  group: string,
  plural: string,
  kind: string,
  canList = true,
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

const kind = (group: string, plural: string, label: string) => ({
  label,
  group,
  plural,
});

test("baseDomain keeps the last two labels, and whole single-label, numeric and two-label groups", () => {
  expect(baseDomain("pkg.crossplane.io")).toBe("crossplane.io");
  expect(baseDomain("cert-manager.io")).toBe("cert-manager.io");
  expect(baseDomain("cilium.io")).toBe("cilium.io");
  expect(baseDomain("metrics")).toBe("metrics");
  expect(baseDomain("10.0.0.1")).toBe("10.0.0.1");
  expect(baseDomain("a.1.2")).toBe("a.1.2");
  expect(baseDomain("a.b.c.d.example.com")).toBe("example.com");
});

test("a domain with one group is a group row named with the full group", () => {
  expect(
    crdTree([
      info("cert-manager.io", "issuers", "Issuer"),
      info("cert-manager.io", "certificates", "Certificate"),
    ]),
  ).toEqual([
    {
      domain: "cert-manager.io",
      type: "group",
      label: "cert-manager.io",
      title: "cert-manager.io",
      items: [
        kind("cert-manager.io", "certificates", "Certificate"),
        kind("cert-manager.io", "issuers", "Issuer"),
      ],
      groups: [],
      count: 2,
    },
  ]);
});

test("a group equal to its domain lists its kinds before the level-2 rows, which drop the domain", () => {
  const [row] = crdTree([
    info("pkg.crossplane.io", "providers", "Provider"),
    info("acl.kafka.m.crossplane.io", "topics", "Topic"),
    info("crossplane.io", "compositions", "Composition"),
    info("pkg.crossplane.io", "functions", "Function"),
  ]);
  expect(row).toEqual({
    domain: "crossplane.io",
    type: "domain",
    label: "crossplane.io",
    title: "crossplane.io · 3 API groups",
    items: [kind("crossplane.io", "compositions", "Composition")],
    groups: [
      {
        group: "acl.kafka.m.crossplane.io",
        label: "acl.kafka.m",
        items: [kind("acl.kafka.m.crossplane.io", "topics", "Topic")],
      },
      {
        group: "pkg.crossplane.io",
        label: "pkg",
        items: [
          kind("pkg.crossplane.io", "functions", "Function"),
          kind("pkg.crossplane.io", "providers", "Provider"),
        ],
      },
    ],
    count: 4,
  });
});

test("every level sorts by its label, a group row by its full name among domain rows, kinds by kind then plural", () => {
  const rows = crdTree([
    info("zeta.io", "z", "Z"),
    info("b.acme.io", "bs", "B"),
    info("a.acme.io", "as", "A"),
    info("monitoring.coreos.com", "probes", "Probe"),
    info("monitoring.coreos.com", "alerts", "Alert"),
    info("monitoring.coreos.com", "alertz", "Alert"),
  ]);
  expect(rows.map((r) => [r.type, r.label])).toEqual([
    ["domain", "acme.io"],
    ["group", "monitoring.coreos.com"],
    ["group", "zeta.io"],
  ]);
  expect(rows[0].groups.map((g) => g.label)).toEqual(["a", "b"]);
  expect(rows[1].items.map((i) => i.plural)).toEqual([
    "alerts",
    "alertz",
    "probes",
  ]);
});

test("built-in groups, unlistable kinds and nav-listed kinds stay out; add-on groups stay in the k8s.io domain", () => {
  const rows = crdTree([
    info("internal.apiserver.k8s.io", "storageversions", "StorageVersion"),
    info(
      "storagemigration.k8s.io",
      "storageversionmigrations",
      "StorageVersionMigration",
    ),
    info("apps", "deployments", "Deployment"),
    info("gateway.networking.k8s.io", "httproutes", "HTTPRoute"),
    info("argoproj.io", "applications", "Application"),
    info("acme.io", "gadgets", "Gadget", false),
    info("metrics.k8s.io", "pods", "PodMetrics"),
    info("gateway.networking.k8s.io", "backendtlspolicies", "BackendTLSPolicy"),
  ]);
  expect(rows).toEqual([
    {
      domain: "k8s.io",
      type: "domain",
      label: "k8s.io",
      title: "k8s.io · 2 API groups",
      items: [],
      groups: [
        {
          group: "gateway.networking.k8s.io",
          label: "gateway.networking",
          items: [
            kind(
              "gateway.networking.k8s.io",
              "backendtlspolicies",
              "BackendTLSPolicy",
            ),
          ],
        },
        {
          group: "metrics.k8s.io",
          label: "metrics",
          items: [kind("metrics.k8s.io", "pods", "PodMetrics")],
        },
      ],
      count: 2,
    },
  ]);
});

test("5,000 kinds in 1,000 groups give 100 domain rows with the right counts", () => {
  const resources: ApiResourceInfo[] = [];
  for (let g = 0; g < 1000; g += 1) {
    for (let k = 0; k < 5; k += 1) {
      resources.push(info(`g${g}.d${g % 100}.io`, `k${k}s`, `K${k}`));
    }
  }
  const rows = crdTree(resources);
  expect(rows).toHaveLength(100);
  for (const row of rows) {
    expect(row.type).toBe("domain");
    expect(row.groups).toHaveLength(10);
    expect(row.count).toBe(50);
    expect(row.title).toBe(`${row.domain} · 10 API groups`);
  }
});
