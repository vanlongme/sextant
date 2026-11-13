import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { ApplicationSetDetail } from "./ApplicationSetDetail";
import { AppProjectDetail } from "./AppProjectDetail";
import { APP_PROJECTS, APPLICATION_SETS, APPLICATIONS } from "./common";

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

const SERVED = [{ resource: APPLICATIONS } as unknown as ApiResourceInfo];

it("an ApplicationSet shows generators, generated Applications, its template and the note", () => {
  mockBackend({});
  render(
    <MemoryRouter>
      <ApplicationSetDetail
        clusterId="c"
        resource={APPLICATION_SETS}
        resources={SERVED}
        object={{
          metadata: { name: "teams", namespace: "argocd" },
          spec: {
            generators: [{ list: { elements: [{}, {}] } }],
            template: {
              metadata: { name: "team-{{team}}" },
              spec: { project: "default" },
            },
          },
          status: {
            resources: [
              {
                kind: "Application",
                namespace: "argocd",
                name: "team-a",
                status: "Synced",
                health: { status: "Healthy" },
              },
            ],
          },
        }}
      />
    </MemoryRouter>,
  );
  expect(
    within(screen.getByTestId("appset-generators")).getByText("2 elements"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("appset-applications")).getByRole("link", {
      name: "team-a",
    }),
  ).toBeTruthy();
  expect(screen.getByTestId("appset-template").textContent).toContain(
    "name: team-{{team}}",
  );
  expect(
    screen.getByText(
      "SkoposIDE shows ApplicationSets read only. Change them in git, or with Edit.",
    ),
  ).toBeTruthy();
});

it("a bare ApplicationSet shows the empty texts", () => {
  mockBackend({});
  render(
    <MemoryRouter>
      <ApplicationSetDetail
        clusterId="c"
        resource={APPLICATION_SETS}
        resources={[]}
        object={{ metadata: { name: "x" } }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("No generators.")).toBeTruthy();
  expect(screen.getByText("No Applications reported.")).toBeTruthy();
  expect(screen.getByText("No template.")).toBeTruthy();
});

const PLATFORM: KubeObject = {
  metadata: { name: "platform", namespace: "argocd" },
  spec: {
    destinations: [
      { server: "https://kubernetes.default.svc", namespace: "edge" },
    ],
    sourceRepos: ["https://git.example.test/platform/*"],
    syncWindows: [
      {
        kind: "deny",
        schedule: "0 22 * * *",
        duration: "1h",
        applications: ["*"],
      },
    ],
  },
};

function showProject(project: KubeObject) {
  render(
    <MemoryRouter>
      <AppProjectDetail
        clusterId="c"
        resource={APP_PROJECTS}
        resources={SERVED}
        object={project}
      />
    </MemoryRouter>,
  );
}

it("an AppProject shows destinations, repositories, windows and its own Applications", async () => {
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
  showProject(PLATFORM);
  await act(flush); // lets the subscription reach the mock, which sets `send`
  expect(
    within(screen.getByTestId("appproject-destinations")).getByText("edge"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("appproject-sources")).getByText(
      "https://git.example.test/platform/*",
    ),
  ).toBeTruthy();
  const windows = screen.getByTestId("appproject-windows");
  expect(within(windows).getByText("0 22 * * *")).toBeTruthy();
  expect(within(windows).getByText("Applications: *")).toBeTruthy();
  expect(
    within(windows).getByText(/SkoposIDE does not evaluate sync windows/),
  ).toBeTruthy();
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        {
          metadata: { name: "edge-proxy", namespace: "argocd" },
          spec: { project: "platform" },
          status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
        },
        {
          metadata: { name: "other", namespace: "argocd" },
          spec: { project: "default" },
        },
      ],
    } as unknown as WatchEvent);
    await flush();
  });
  const apps = screen.getByTestId("appproject-applications");
  expect(within(apps).getByRole("link", { name: "edge-proxy" })).toBeTruthy();
  expect(within(apps).queryByText("other")).toBeNull();
});

it("an AppProject says when Applications cannot be listed", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "Forbidden", message: "no", details: null };
    },
  });
  showProject({ metadata: { name: "x", namespace: "argocd" } });
  await act(flush);
  expect(screen.getByText("Cannot list Applications.")).toBeTruthy();
  expect(screen.getByText("No sync windows.")).toBeTruthy();
  expect(screen.getByText("No destinations.")).toBeTruthy();
  expect(screen.getByText("No source repositories.")).toBeTruthy();
});
