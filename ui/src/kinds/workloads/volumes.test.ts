import { expect, test } from "vitest";
import {
  claimTemplateItems,
  cronJobPodSpec,
  mountLines,
  templatePodSpec,
  volumeRows,
  wrapPath,
} from "./volumes";

const ZWSP = "​";

const SPEC = {
  initContainers: [
    { name: "init", volumeMounts: [{ name: "data", mountPath: "/seed" }] },
  ],
  containers: [
    {
      name: "app",
      volumeMounts: [
        { name: "data", mountPath: "/var/lib/data", readOnly: true },
        { name: "config", mountPath: "/etc/app", subPath: "app.yaml" },
      ],
    },
  ],
  volumes: [
    { name: "config", configMap: { name: "app-config" } },
    { name: "creds", secret: { secretName: "app-secret" } },
    {
      name: "data",
      persistentVolumeClaim: { claimName: "data-0", readOnly: true },
    },
    { name: "cache", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
    { name: "scratch", emptyDir: {} },
    {
      name: "token",
      projected: {
        sources: [
          { serviceAccountToken: { path: "token" } },
          { configMap: { name: "kube-root-ca.crt" } },
          { secret: { name: "extra" } },
          {
            downwardAPI: {
              items: [{ fieldRef: { fieldPath: "metadata.namespace" } }],
            },
          },
          { clusterTrustBundle: { signerName: "example.com/signer" } },
        ],
      },
    },
    { name: "host", hostPath: { path: "/var/log", type: "Directory" } },
    {
      name: "info",
      downwardAPI: {
        items: [
          { fieldRef: { fieldPath: "metadata.labels" } },
          { fieldRef: { fieldPath: "metadata.name" } },
        ],
      },
    },
    { name: "csi", csi: { driver: "secrets-store.csi.k8s.io" } },
    { name: "share", nfs: { server: "10.0.0.5", path: "/exports" } },
    { name: "eph", ephemeral: { volumeClaimTemplate: { spec: {} } } },
    { name: "img", image: { reference: "registry.k8s.io/pause:3.10" } },
    { name: "odd", gitRepo: { repository: "x" } },
  ],
};

test("wrapPath lets a path break after each slash", () => {
  expect(wrapPath("/var/lib/data")).toBe(`/${ZWSP}var/${ZWSP}lib/${ZWSP}data`);
});

test("mounts list init containers first, with ro and subPath", () => {
  expect(mountLines(SPEC, "data")).toEqual([
    { text: `init → /${ZWSP}seed`, title: "/seed" },
    {
      text: `app → /${ZWSP}var/${ZWSP}lib/${ZWSP}data, ro`,
      title: "/var/lib/data",
    },
  ]);
  expect(mountLines(SPEC, "config")).toEqual([
    {
      text: `app → /${ZWSP}etc/${ZWSP}app, subPath app.yaml`,
      title: "/etc/app",
    },
  ]);
  expect(mountLines(SPEC, "creds")).toEqual([]);
});

test("each volume type has its badge and source lines", () => {
  const rows = volumeRows(SPEC, "n", "web-0");
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(rows.map((r) => r.name)).toEqual(SPEC.volumes.map((v) => v.name));
  expect(byName.config).toMatchObject({
    type: "ConfigMap",
    source: [
      [
        {
          text: "app-config",
          link: { kind: "ConfigMap", name: "app-config", namespace: "n" },
        },
      ],
    ],
  });
  expect(byName.creds.source).toEqual([
    [
      {
        text: "app-secret",
        link: { kind: "Secret", name: "app-secret", namespace: "n" },
      },
    ],
  ]);
  expect(byName.data).toMatchObject({
    type: "PersistentVolumeClaim",
    source: [
      [
        {
          text: "data-0",
          link: {
            kind: "PersistentVolumeClaim",
            name: "data-0",
            namespace: "n",
          },
        },
        { text: ", ro" },
      ],
    ],
  });
  expect(byName.cache).toMatchObject({
    type: "EmptyDir",
    source: [[{ text: "Memory, 1Gi limit" }]],
  });
  expect(byName.scratch.source).toEqual([[{ text: "Node disk" }]]);
  expect(byName.token.type).toBe("Projected");
  expect(byName.token.source).toEqual([
    [{ text: "ServiceAccount token ", muted: true }, { text: "3600s" }],
    [
      { text: "ConfigMap ", muted: true },
      {
        text: "kube-root-ca.crt",
        link: { kind: "ConfigMap", name: "kube-root-ca.crt", namespace: "n" },
      },
    ],
    [
      { text: "Secret ", muted: true },
      {
        text: "extra",
        link: { kind: "Secret", name: "extra", namespace: "n" },
      },
    ],
    [
      { text: "DownwardAPI ", muted: true },
      { text: "metadata.namespace", mono: true },
    ],
    [
      { text: "ClusterTrustBundle ", muted: true },
      { text: "example.com/signer", mono: true },
    ],
  ]);
  expect(byName.host).toMatchObject({
    type: "HostPath",
    source: [
      [
        { text: "/var/log", mono: true },
        { text: " Directory", muted: true },
      ],
    ],
  });
  expect(byName.info).toMatchObject({
    type: "DownwardAPI",
    source: [[{ text: "metadata.labels, metadata.name", mono: true }]],
  });
  expect(byName.csi).toMatchObject({
    type: "CSI",
    source: [[{ text: "secrets-store.csi.k8s.io", mono: true }]],
  });
  expect(byName.share).toMatchObject({
    type: "NFS",
    source: [[{ text: "10.0.0.5:/exports", mono: true }]],
  });
  expect(byName.eph).toMatchObject({
    type: "Ephemeral",
    source: [
      [
        {
          text: "web-0-eph",
          link: {
            kind: "PersistentVolumeClaim",
            name: "web-0-eph",
            namespace: "n",
          },
        },
      ],
    ],
  });
  expect(byName.img).toMatchObject({
    type: "Image",
    source: [[{ text: "registry.k8s.io/pause:3.10", mono: true }]],
  });
  expect(byName.odd).toMatchObject({ type: "GitRepo", source: [] });
  expect(byName.data.mounted).toHaveLength(2);
});

test("a token's own expiry wins, and a template has no Pod name for ephemeral claims", () => {
  const spec = {
    volumes: [
      {
        name: "t",
        projected: {
          sources: [{ serviceAccountToken: { expirationSeconds: 600 } }],
        },
      },
      { name: "eph", ephemeral: {} },
    ],
  };
  const [token, eph] = volumeRows(spec, "n", null);
  expect(token.source).toEqual([
    [{ text: "ServiceAccount token ", muted: true }, { text: "600s" }],
  ]);
  expect(eph.source).toEqual([[{ text: "Claim per Pod" }]]);
  expect(volumeRows({}, "n", null)).toEqual([]);
  expect(volumeRows(undefined, "n", null)).toEqual([]);
});

test("templates and CronJobs give their Pod spec", () => {
  const spec = { containers: [] };
  expect(
    templatePodSpec({ metadata: { name: "d" }, spec: { template: { spec } } }),
  ).toBe(spec);
  expect(
    cronJobPodSpec({
      metadata: { name: "c" },
      spec: { jobTemplate: { spec: { template: { spec } } } },
    }),
  ).toBe(spec);
  expect(templatePodSpec({ metadata: { name: "d" } })).toBeUndefined();
});

test("a StatefulSet's claim templates are Volumes items", () => {
  const items = claimTemplateItems({
    metadata: { name: "db" },
    spec: {
      template: {
        spec: {
          containers: [
            { name: "pg", volumeMounts: [{ name: "data", mountPath: "/pg" }] },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data" },
          spec: {
            storageClassName: "fast",
            resources: { requests: { storage: "10Gi" } },
          },
        },
        {
          metadata: { name: "logs" },
          spec: { resources: { requests: { storage: "1Gi" } } },
        },
      ],
    },
  });
  expect(items).toEqual([
    {
      name: "data",
      type: "Claim template",
      source: [[{ text: "One claim per Pod, fast, 10Gi" }]],
      mounted: [{ text: `pg → /${ZWSP}pg`, title: "/pg" }],
    },
    {
      name: "logs",
      type: "Claim template",
      source: [[{ text: "One claim per Pod, default class, 1Gi" }]],
      mounted: [],
    },
  ]);
});
