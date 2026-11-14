import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import type { TableColumn } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import { type KindSpec, registerKind } from "../../kinds/registry";
import { OverviewSections, summaryStats } from "./OverviewSections";

const THINGS: ResourceRef = {
  group: "test.skopos",
  version: "v1",
  plural: "things",
  kind: "Thing",
  namespaced: true,
};

const SERVED: ApiResourceInfo[] = [
  ["", "configmaps", "ConfigMap"],
  ["", "namespaces", "Namespace"],
  ["apps", "replicasets", "ReplicaSet"],
].map(([group, plural, kind]) => ({
  resource: {
    group,
    version: "v1",
    plural,
    kind,
    namespaced: plural !== "namespaces",
  },
  verbs: [],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
}));

const column = (id: string, header: string): TableColumn<KubeObject> => ({
  id,
  header,
  width: 80,
  render: (o) => <span>{`${header} of ${o.metadata.name}`}</span>,
});

const COLUMNS = [
  column("name", "Name"),
  column("status", "Status"),
  column("age", "Age"),
  column("actions", "Actions"),
];

const thing = (over: Partial<KubeObject> = {}): KubeObject => ({
  metadata: {
    name: "t1",
    namespace: "n",
    uid: "u1",
    creationTimestamp: "2026-01-01T00:00:00Z",
  },
  status: { conditions: [{ type: "Ready", status: "True" }] },
  ...over,
});

function show(spec: KindSpec, object = thing(), columns = COLUMNS) {
  registerKind(THINGS.group, THINGS.plural, spec);
  return render(
    <MemoryRouter>
      <OverviewSections
        clusterId="c1"
        resource={THINGS}
        object={object}
        resources={SERVED}
        columns={columns}
      />
    </MemoryRouter>,
  );
}

const sectionIds = () =>
  [...document.querySelectorAll("section[data-testid]")].map((s) =>
    s.getAttribute("data-testid"),
  );

afterEach(() => registerKind(THINGS.group, THINGS.plural, {}));

test("summaryStats keeps the columns but Name, Namespace, Age and Actions", () => {
  expect(summaryStats(COLUMNS, thing()).map((s) => [s.id, s.label])).toEqual([
    ["status", "Status"],
  ]);
});

test("a kind without hooks shows Summary, Relations, Conditions, Fields and Metadata", () => {
  show({});
  expect(sectionIds()).toEqual([
    "detail-summary",
    "detail-relations",
    "detail-conditions",
    "detail-metadata",
  ]);
  expect(screen.getByTestId("detail-section-toggle-fields")).toBeTruthy();
  expect(screen.getByTestId("detail-stat-status").textContent).toBe(
    "StatusStatus of t1",
  );
  expect(screen.queryByTestId("copy-status")).toBeNull();
});

test("a kind's summary hook replaces the columns and can read a cell", () => {
  show({
    summary: (_o, cell, props) => [
      { id: "phase", label: "Phase", value: cell("status") },
      {
        id: "where",
        label: "Cluster",
        value: props.clusterId,
        title: "Its cluster",
      },
      { id: "none", label: "None", value: cell("nope") ?? "-" },
    ],
  });
  const summary = screen.getByTestId("detail-summary");
  expect(within(summary).getByTestId("detail-stat-phase").textContent).toBe(
    "PhaseStatus of t1",
  );
  expect(
    within(summary).getByTestId("detail-stat-where").getAttribute("title"),
  ).toBe("Its cluster");
  expect(within(summary).getByTestId("detail-stat-none").textContent).toBe(
    "None-",
  );
});

test("Relations link the Namespace, the controller and the other owners, then the kind's facts", () => {
  show(
    { relations: () => [{ label: "Service account", value: "default" }] },
    thing({
      metadata: {
        ...thing().metadata,
        ownerReferences: [
          { apiVersion: "x.io/v1", kind: "Widget", name: "w", uid: "o2" },
          {
            apiVersion: "apps/v1",
            kind: "ReplicaSet",
            name: "rs",
            uid: "o1",
            controller: true,
          },
        ],
      },
    }),
  );
  const relations = screen.getByTestId("detail-relations");
  const rows = [...relations.querySelectorAll("dt")].map((d) => d.textContent);
  expect(rows).toEqual([
    "Namespace",
    "Controlled by",
    "Owners",
    "Service account",
  ]);
  expect(
    within(relations).getByRole("link", { name: "n" }).getAttribute("href"),
  ).toBe("/cluster/c1/r/core/namespaces?object=%2Fn");
  const owner = within(relations).getByTestId("detail-owner-link");
  expect(owner.textContent).toBe("rs");
  expect(owner.getAttribute("href")).toBe(
    "/cluster/c1/r/apps/replicasets?object=n%2Frs",
  );
  expect(within(relations).getByText("Widget w")).toBeTruthy();
});

test("without a controller, a pod-spec kind says None and another kind leaves the fact out", () => {
  const { unmount } = show({ podSpec: () => ({ spec: {}, podName: null }) });
  expect(
    within(screen.getByTestId("detail-relations")).getByText("None"),
  ).toBeTruthy();
  unmount();
  show({});
  expect(
    within(screen.getByTestId("detail-relations")).queryByText("Controlled by"),
  ).toBeNull();
});

test("a pod-spec kind lists its volumes and claim templates with links and mounts", () => {
  show({
    podSpec: () => ({
      spec: {
        containers: [
          {
            name: "app",
            volumeMounts: [{ name: "config", mountPath: "/etc/app" }],
          },
        ],
        volumes: [{ name: "config", configMap: { name: "app-config" } }],
      },
      podName: null,
      claimTemplates: [
        {
          name: "data",
          type: "Claim template",
          source: [[{ text: "One claim per Pod, default class, 1Gi" }]],
          mounted: [],
        },
      ],
    }),
  });
  const volumes = screen.getByTestId("detail-volumes");
  expect(screen.getByTestId("detail-section-toggle-volumes").textContent).toBe(
    "Volumes2",
  );
  const config = within(volumes).getByTestId("detail-volume-config");
  expect(within(config).getByText("ConfigMap")).toBeTruthy();
  expect(
    within(config)
      .getByRole("link", { name: "app-config" })
      .getAttribute("href"),
  ).toBe("/cluster/c1/r/core/configmaps?object=n%2Fapp-config");
  expect(within(config).getByTitle("/etc/app").textContent).toBe(
    "app → /​etc/​app",
  );
  expect(
    within(volumes).getByTestId("detail-volume-data").textContent,
  ).toContain("One claim per Pod");
});

test("a kind with its own conditions has no Conditions card, and a detail replaces Fields", () => {
  show({ ownConditions: true, detail: () => <p data-testid="own">own</p> });
  expect(screen.queryByTestId("detail-conditions")).toBeNull();
  expect(screen.getByTestId("own")).toBeTruthy();
  expect(screen.queryByTestId("detail-section-toggle-fields")).toBeNull();
});

test("Metadata shows Created in UTC, links the Namespace, and the label and annotation expanders", () => {
  show(
    {},
    thing({
      metadata: { ...thing().metadata, labels: { app: "web", tier: "front" } },
    }),
  );
  const metadata = screen.getByTestId("detail-metadata");
  expect(within(metadata).getByText("2026-01-01 00:00:00 UTC")).toBeTruthy();
  expect(within(metadata).getByRole("link", { name: "n" })).toBeTruthy();
  const labels = screen.getByTestId("detail-expand-labels");
  expect(labels.textContent).toBe("Labels2app=web, tier=front");
  expect(screen.getByTestId("detail-annotations").textContent).toBe(
    "AnnotationsNone",
  );
});
