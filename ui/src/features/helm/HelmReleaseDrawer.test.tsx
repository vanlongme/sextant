import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HelmRelease } from "../../ipc/generated/HelmRelease";
import type { HelmReleaseDetail } from "../../ipc/generated/HelmReleaseDetail";
import { resetHelmForTest, runKey, useHelm } from "../../stores/helm";
import { detail, release, releaseList, revision } from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { HelmReleaseDrawer } from "./HelmReleaseDrawer";

const CONFIG_MAPS = {
  group: "",
  version: "v1",
  plural: "configmaps",
  kind: "ConfigMap",
  namespaced: true,
};
const HISTORY = [
  revision({
    revision: 2,
    status: "deployed",
    description: "Upgrade complete",
  }),
  revision({ revision: 1, description: "Install complete" }),
];

beforeEach(() => {
  resetHelmForTest();
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function Location() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

function handlers(over: Partial<HelmReleaseDetail> = {}) {
  return {
    helm_release_list: () => releaseList([release({ name: "web" })]),
    helm_release_get: () => detail({ name: "web", revision: 2, ...over }),
    helm_release_history: () => HISTORY,
    helm_release_values: (args: { all: boolean }) =>
      args.all ? "replicaCount: 2\nimage: nginx\n" : "",
  };
}

function view(listed: HelmRelease | undefined, listLoaded = true) {
  return (
    <MemoryRouter>
      <HelmReleaseDrawer
        clusterId="c1"
        namespace="shop"
        name="web"
        listed={listed}
        listLoaded={listLoaded}
        onClose={() => {}}
      />
      <Location />
    </MemoryRouter>
  );
}

async function show(
  over: Parameters<typeof mockBackend>[0] = handlers(),
  listed: HelmRelease | undefined = release({ name: "web", revision: 2 }),
) {
  const backend = mockBackend(over);
  const rendered = render(view(listed));
  await act(flush);
  return { backend, ...rendered };
}

async function openTab(id: string) {
  fireEvent.mouseDown(screen.getByTestId(id), { button: 0 });
  await act(flush);
}

test("the overview shows the facts, the notes and the resources with their links", async () => {
  await show({
    ...handlers({
      notes: "Visit http://web.shop",
      resources: [
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          namespace: "shop",
          name: "web-config",
          ref: CONFIG_MAPS,
        },
        {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "ClusterRole",
          namespace: null,
          name: "web-reader",
          ref: null,
        },
      ],
    }),
  });
  expect(screen.getByText("Helm release in shop")).toBeTruthy();
  expect(screen.getByTestId("helm-release-drawer-status").textContent).toBe(
    "deployed",
  );
  const facts = screen.getByTestId("helm-release-facts").textContent;
  expect(facts).toContain("nginx 1.2.3");
  expect(facts).toContain("First deployed2026-11-09 08:00:00 UTC · 28h ago");
  expect(facts).toContain("Last deployed2026-11-10 09:00:00 UTC · 3h ago");
  expect(screen.getByTestId("helm-release-notes").textContent).toBe(
    "Visit http://web.shop",
  );
  const resources = screen.getByTestId("helm-release-resources");
  fireEvent.click(within(resources).getByRole("link", { name: "web-config" }));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/r/core/configmaps?object=shop%2Fweb-config",
  );
  expect(
    within(resources).queryByRole("link", { name: "web-reader" }),
  ).toBeNull();
  expect(resources.textContent).toContain("web-reader—");
});

test("a chart with no name or version reads as helm's chart text", async () => {
  await show(handlers({ chartName: null, chart: "web-0.1.0" }));
  expect(screen.getByTestId("helm-release-facts").textContent).toContain(
    "Chartweb-0.1.0",
  );
});

test("an uninstalled release says so and offers only Uninstall", async () => {
  await show(
    handlers({ status: "uninstalled" }),
    release({ name: "web", revision: 2, status: "uninstalled" }),
  );
  expect(screen.getByTestId("helm-release-uninstalled")).toBeTruthy();
  expect(screen.queryByTestId("helm-release-upgrade")).toBeNull();
  expect(screen.queryByTestId("helm-release-rollback")).toBeNull();
  expect(screen.getByTestId("helm-release-uninstall")).toBeTruthy();
});

test.each([
  [
    1,
    [revision({ revision: 1, status: "failed" })],
    "The last install failed: timed out. Fix the values and upgrade again.",
  ],
  [
    3,
    [
      revision({ revision: 3, status: "failed" }),
      revision({ revision: 2, status: "superseded" }),
    ],
    "The last upgrade failed: timed out. Roll back to revision 2, or fix the values and upgrade again.",
  ],
])(
  "a failed release at revision %i explains what to do",
  async (rev, history, text) => {
    await show(
      {
        ...handlers({
          status: "failed",
          revision: rev,
          description: "timed out",
        }),
        helm_release_history: () => history,
      },
      release({ name: "web", revision: rev, status: "failed" }),
    );
    expect(screen.getByTestId("helm-release-failed").textContent).toBe(text);
  },
);

test("a busy release hides its actions and says helm is working", async () => {
  await show(
    handlers({ status: "pending-upgrade", description: "Preparing upgrade" }),
    release({ name: "web", revision: 2, status: "pending-upgrade" }),
  );
  expect(screen.getByTestId("helm-release-busy").textContent).toBe(
    "helm is working on this release: Preparing upgrade. Its actions come back when it finishes.",
  );
  expect(screen.queryByTestId("helm-release-upgrade")).toBeNull();
  expect(screen.queryByTestId("helm-release-uninstall")).toBeNull();
});

test("a running run makes the release busy too", async () => {
  useHelm.setState({
    runs: {
      [runKey("c1", "shop", "web")]: {
        key: runKey("c1", "shop", "web"),
        id: 1,
        kind: "rollback",
        clusterId: "c1",
        namespace: "shop",
        release: "web",
        revision: 1,
        keepHistory: false,
        sessionId: "s",
        phase: "running",
        output: "",
        error: null,
        rejected: false,
      },
    },
  });
  await show();
  expect(screen.getByTestId("helm-release-busy").textContent).toBe(
    "helm is working on this release: Install complete. Its actions come back when it finishes.",
  );
});

test("Upgrade opens the upgrade page; Roll back and Uninstall open their dialogs", async () => {
  await show();
  fireEvent.click(screen.getByTestId("helm-release-rollback"));
  expect(await screen.findByTestId("helm-rollback-dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByTestId("helm-release-uninstall"));
  expect(await screen.findByTestId("helm-uninstall-dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByTestId("helm-release-upgrade"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/upgrade/shop/web",
  );
});

test("Values shows both blocks, with the none text for empty user values", async () => {
  const { backend } = await show();
  expect(backend.callsTo("helm_release_values")).toEqual([]);
  await openTab("helm-release-tab-values");
  expect(screen.getByTestId("helm-release-user-values").textContent).toBe(
    "# none: the chart defaults apply",
  );
  expect(screen.getByTestId("helm-release-computed-values").textContent).toBe(
    "replicaCount: 2\nimage: nginx\n",
  );
  expect(backend.callsTo("helm_release_values")).toEqual([
    { clusterId: "c1", namespace: "shop", name: "web", all: false },
    { clusterId: "c1", namespace: "shop", name: "web", all: true },
  ]);
});

test("Manifest shows the current revision's manifest, or says there is none", async () => {
  const first = await show(handlers({ manifest: "kind: ConfigMap\n" }));
  await openTab("helm-release-tab-manifest");
  expect(
    screen.getByRole("heading", { name: "Manifest of revision 2" }),
  ).toBeTruthy();
  expect(screen.getByTestId("helm-release-manifest").textContent).toBe(
    "kind: ConfigMap\n",
  );
  first.unmount();
  await show(handlers({ manifest: "" }));
  await openTab("helm-release-tab-manifest");
  expect(
    screen.getByText("helm has no manifest for this revision."),
  ).toBeTruthy();
});

test("History lists the revisions with a Roll back link on every row but the current one", async () => {
  await show();
  expect(screen.getByTestId("helm-release-tab-history").textContent).toBe(
    "History (2)",
  );
  await openTab("helm-release-tab-history");
  const row = (n: number) =>
    Array.from(
      screen.getByTestId(`helm-release-revision-${n}`).querySelectorAll("td"),
    ).map((c) => c.textContent);
  expect(row(2)).toEqual([
    "2",
    "3h ago",
    "deployed",
    "nginx-1.2.3",
    "1.25.0",
    "Upgrade complete",
    "",
  ]);
  expect(screen.queryByTestId("helm-release-revision-rollback-2")).toBeNull();
  fireEvent.click(screen.getByTestId("helm-release-revision-rollback-1"));
  expect(
    (await screen.findByTestId("helm-rollback-revision")).textContent,
  ).toBe("Revision 1 · nginx-1.2.3 · superseded");
});

test("a release that is not found is gone", async () => {
  await show({
    ...handlers(),
    helm_release_get: () => {
      throw { code: "NotFound", message: "release: not found", details: null };
    },
  });
  expect(screen.getByTestId("helm-release-gone").textContent).toBe(
    "The release shop/web is gone; it may have been uninstalled.",
  );
  expect(screen.queryByTestId("helm-release-uninstall")).toBeNull();
});

test("it reads again when the list shows a new revision or status, not on the list's first answer", async () => {
  const backend = mockBackend(handlers());
  const { rerender } = render(view(undefined, false));
  await act(flush);
  expect(backend.callsTo("helm_release_get")).toHaveLength(1);
  rerender(view(release({ name: "web", revision: 2 })));
  await act(flush);
  expect(backend.callsTo("helm_release_get")).toHaveLength(1);
  rerender(view(release({ name: "web", revision: 3 })));
  await act(flush);
  expect(backend.callsTo("helm_release_get")).toHaveLength(2);
  expect(backend.callsTo("helm_release_history")).toHaveLength(2);
  rerender(view(release({ name: "web", revision: 3, status: "uninstalled" })));
  await act(flush);
  expect(backend.callsTo("helm_release_get")).toHaveLength(3);
});
