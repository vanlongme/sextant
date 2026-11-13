import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../objects";
import { ApplicationDetail } from "./ApplicationDetail";
import { APP_PROJECTS, APPLICATIONS } from "./common";

const SERVED = [
  { resource: APP_PROJECTS } as unknown as ApiResourceInfo,
  {
    resource: {
      group: "apps",
      version: "v1",
      plural: "deployments",
      kind: "Deployment",
      namespaced: true,
    },
  } as unknown as ApiResourceInfo,
];

function show(object: KubeObject) {
  render(
    <MemoryRouter>
      <ApplicationDetail
        clusterId="c"
        object={object}
        resource={APPLICATIONS}
        resources={SERVED}
      />
    </MemoryRouter>,
  );
}

const GUESTBOOK: KubeObject = {
  metadata: {
    name: "guestbook",
    namespace: "argocd",
    annotations: { "argocd.argoproj.io/refresh": "hard" },
  },
  spec: {
    project: "default",
    sources: [
      {
        repoURL: "https://git.example.test/apps.git",
        path: "guestbook",
        targetRevision: "main",
      },
      {
        repoURL: "https://git.example.test/values.git",
        targetRevision: "main",
        ref: "values",
      },
    ],
    destination: { name: "in-cluster", namespace: "guestbook" },
    syncPolicy: { automated: { prune: true } },
  },
  operation: { sync: {}, initiatedBy: { username: "ci-bot" } },
  status: {
    operationState: {
      phase: "Running",
      message: "waiting for healthy state",
      startedAt: new Date().toISOString(),
      operation: { initiatedBy: { username: "ci-bot" } },
    },
    resources: [
      {
        group: "apps",
        version: "v1",
        kind: "Deployment",
        namespace: "guestbook",
        name: "guestbook-ui",
        status: "Synced",
        health: { status: "Healthy" },
      },
    ],
    history: [
      {
        id: 1,
        revision: "9b07e3d2c4a6b8d0e2f4a6c8e0b2d4f6a8c0e2b4",
        deployedAt: "2026-11-12T10:00:00Z",
        initiatedBy: { username: "admin" },
      },
      {
        id: 2,
        revision: "4f2c9a1d0b6e8f7a3c5d9e1b2a4c6e8f0a1b3c5d",
        deployedAt: "2026-11-13T10:00:00Z",
        initiatedBy: { automated: true },
      },
    ],
  },
};

it("shows the operation note, facts, sources, last operation, resources and history", () => {
  show(GUESTBOOK);
  expect(screen.getByTestId("argocd-operation-note").textContent).toContain(
    "started by ci-bot. Terminate stops it.",
  );
  const project = screen.getByRole("link", { name: "default" });
  expect(project.getAttribute("href")).toContain("/r/argoproj.io/appprojects");
  expect(screen.getByText("On, prune")).toBeTruthy();
  expect(screen.getByText("in-cluster, namespace guestbook")).toBeTruthy();
  expect(screen.getByText("Requested (Hard)")).toBeTruthy();
  const sources = screen.getByTestId("argocd-sources");
  expect(within(sources).getByText("Sources (2)")).toBeTruthy();
  expect(within(sources).getByText("main · ref values")).toBeTruthy();
  const last = screen.getByTestId("argocd-last-operation");
  expect(within(last).getByText("Running")).toBeTruthy();
  expect(within(last).getByText("waiting for healthy state")).toBeTruthy();
  const resources = screen.getByTestId("argocd-resources");
  expect(
    within(resources).getByRole("link", { name: "guestbook-ui" }),
  ).toBeTruthy();
  expect(within(resources).getByText("Healthy")).toBeTruthy();
  const rows = within(screen.getByTestId("argocd-history")).getAllByRole("row");
  expect(rows[1].textContent).toContain("4f2c9a1");
  expect(rows[1].textContent).toContain("Automated");
  expect(rows[2].textContent).toContain("9b07e3d");
});

it("shows Deleting with the resources finalizer", () => {
  show({
    metadata: {
      name: "gone",
      namespace: "argocd",
      deletionTimestamp: new Date().toISOString(),
      finalizers: ["resources-finalizer.argocd.argoproj.io"],
    } as KubeObject["metadata"],
  });
  expect(screen.getByText(/deleting its resources too/)).toBeTruthy();
});

it("a bare Application renders the empty texts", () => {
  show({ metadata: { name: "bare", namespace: "argocd" } });
  expect(screen.queryByTestId("argocd-operation-note")).toBeNull();
  expect(
    within(screen.getByTestId("argocd-sources")).getByText("Source"),
  ).toBeTruthy();
  expect(screen.getByText("No operation yet.")).toBeTruthy();
  expect(
    screen.getByText("Argo CD has not reported any resources."),
  ).toBeTruthy();
  expect(screen.getByText("Nothing has been deployed yet.")).toBeTruthy();
  expect(screen.getByText("Off")).toBeTruthy();
});
