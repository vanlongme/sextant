import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { HelmReleaseList } from "../../ipc/generated/HelmReleaseList";
import { resetHelmForTest } from "../../stores/helm";
import {
  detail,
  HELM_MISSING,
  release,
  releaseList,
  revision,
  toolStatus,
} from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { HelmReleasesScreen } from "./HelmReleasesScreen";

beforeEach(() => {
  resetHelmForTest();
  mockElementSize();
});

const LIST = releaseList([
  release({ name: "web", revision: 2, updated: null, appVersion: null }),
  release({
    name: "api",
    namespace: "shop",
    chart: "api-0.4.0",
    status: "failed",
  }),
  release({ name: "db", namespace: "data", chart: "postgres-15.0.0" }),
]);

function Location() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

async function show(
  list: HelmReleaseList | (() => HelmReleaseList),
  over: Parameters<typeof mockBackend>[0] = {},
) {
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    helm_release_list: typeof list === "function" ? list : () => list,
    tools_status: () => [toolStatus({ tool: "helm" })],
    helm_release_get: () => detail({ name: "web", revision: 2 }),
    helm_release_history: () => [
      revision({ revision: 2 }),
      revision({ revision: 1 }),
    ],
    ...over,
  });
  render(
    <MemoryRouter initialEntries={["/cluster/c1/helm/releases"]}>
      <HelmReleasesScreen clusterId="c1" />
      <Location />
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

const rowIds = () =>
  Array.from(
    screen
      .getByTestId("helm-releases-table")
      .querySelectorAll("tr[data-testid]"),
  ).map((r) => r.getAttribute("data-testid"));
const cells = (id: string) =>
  Array.from(screen.getByTestId(id).querySelectorAll("td")).map(
    (c) => c.textContent,
  );

async function menuItems(id: string): Promise<string[]> {
  fireEvent.keyDown(screen.getByTestId(`helm-release-menu-${id}`), {
    key: "Enter",
  });
  await act(flush);
  const items = screen
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await act(flush);
  return items;
}

test("lists the releases by namespace, then name, with their columns", async () => {
  const backend = await show(LIST);
  expect(backend.callsTo("helm_release_list")).toEqual([
    { clusterId: "c1", namespaces: null },
  ]);
  expect(screen.getByTestId("helm-releases-count").textContent).toBe("3");
  expect(rowIds()).toEqual([
    "helm-release-data-db",
    "helm-release-shop-api",
    "helm-release-shop-web",
  ]);
  expect(cells("helm-release-shop-web").slice(0, 7)).toEqual([
    "web",
    "shop",
    "nginx-1.2.3",
    "—",
    "2",
    "deployed",
    "—",
  ]);
});

test.each([
  ["deployed", "ok"],
  ["failed", "danger"],
  ["superseded", "neutral"],
  ["pending-upgrade", "warn"],
])("status %s reads in the %s tone", async (status, tone) => {
  await show(releaseList([release({ name: "web", status })]));
  const badge = screen
    .getByTestId("helm-release-status-shop-web")
    .querySelector("span");
  expect(badge?.className).toContain(tone);
});

test("the namespace selection of the resource lists is the one asked for", async () => {
  const backend = await show(LIST, { ui_state_get: () => ["shop"] });
  expect(backend.callsTo("helm_release_list")).toEqual([
    { clusterId: "c1", namespaces: ["shop"] },
  ]);
  expect(backend.callsTo("ui_state_get")).toEqual([{ key: "namespaces:c1" }]);
});

test("search filters on the name, the namespace and the chart", async () => {
  await show(LIST);
  const search = screen.getByTestId("helm-releases-search");
  fireEvent.change(search, { target: { value: "DATA" } });
  expect(rowIds()).toEqual(["helm-release-data-db"]);
  fireEvent.change(search, { target: { value: "api-0" } });
  expect(rowIds()).toEqual(["helm-release-shop-api"]);
  expect(screen.getByTestId("helm-releases-count").textContent).toBe("1");
});

test("the row menu follows the release: no Roll back at revision 1, nothing while busy, only Uninstall when uninstalled", async () => {
  await show(
    releaseList([
      release({ name: "web", revision: 2 }),
      release({ name: "api", revision: 1 }),
      release({ name: "busy", status: "pending-install" }),
      release({ name: "old", status: "uninstalled", revision: 3 }),
    ]),
  );
  expect(await menuItems("shop-web")).toEqual([
    "Upgrade",
    "Roll back",
    "Uninstall",
  ]);
  expect(await menuItems("shop-api")).toEqual(["Upgrade", "Uninstall"]);
  expect(screen.queryByTestId("helm-release-menu-shop-busy")).toBeNull();
  expect(await menuItems("shop-old")).toEqual(["Uninstall"]);
  expect(
    screen.getByTestId("helm-release-menu-shop-web").getAttribute("aria-label"),
  ).toBe("Actions for web");
});

test("the menu opens the upgrade page and the dialogs", async () => {
  await show(LIST);
  fireEvent.keyDown(screen.getByTestId("helm-release-menu-shop-web"), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByTestId("menu-item-uninstall"));
  expect(await screen.findByTestId("helm-uninstall-dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(screen.getByTestId("helm-release-menu-shop-web"), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByTestId("menu-item-rollback"));
  expect(await screen.findByTestId("helm-rollback-dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(screen.getByTestId("helm-release-menu-shop-web"), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByTestId("menu-item-upgrade"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/upgrade/shop/web",
  );
});

test("clicking a row opens its drawer through the URL", async () => {
  await show(LIST);
  fireEvent.click(screen.getByTestId("helm-release-shop-web"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/releases?release=shop%2Fweb",
  );
  expect(await screen.findByText("Helm release in shop")).toBeTruthy();
  fireEvent.click(screen.getByTestId("helm-release-drawer-close"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/releases",
  );
});

test("partial lists and failed namespaces show one notice", async () => {
  await show(
    releaseList([release({ name: "web" })], {
      partial: true,
      failedNamespaces: ["kube-system", "data"],
    }),
  );
  expect(screen.getByTestId("helm-releases-partial").textContent).toBe(
    "You may not list releases in every namespace, so only the namespaces you may read are shown. Could not list releases in kube-system, data.",
  );
});

test("an empty list says so and browses the charts", async () => {
  await show(releaseList([]));
  expect(screen.getByTestId("helm-releases-empty").textContent).toContain(
    "No Helm releases in the namespaces you picked.Install one from Charts.",
  );
  fireEvent.click(screen.getByTestId("helm-releases-browse"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/charts",
  );
});

test("Install a chart opens Charts", async () => {
  await show(LIST);
  fireEvent.click(screen.getByTestId("helm-releases-install"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/charts",
  );
});

test("loading shows a spinner", async () => {
  await show(() => new Promise(() => {}) as never);
  expect(screen.getByRole("status", { name: "Loading releases" })).toBeTruthy();
});

test("a failure shows the error, and Retry lists again", async () => {
  let fail = true;
  const backend = await show(() => {
    if (fail) {
      throw {
        code: "Forbidden",
        message: "secrets is forbidden",
        details: null,
      };
    }
    return LIST;
  });
  expect(screen.getByTestId("helm-releases-error").textContent).toContain(
    "Could not list Helm releases",
  );
  expect(screen.getByText("secrets is forbidden")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(backend.callsTo("helm_release_list")).toHaveLength(2);
  expect(rowIds()).toHaveLength(3);
});

test("missing helm shows the missing block", async () => {
  await show(() => {
    throw HELM_MISSING;
  });
  expect(screen.getByTestId("helm-missing")).toBeTruthy();
  expect(screen.queryByTestId("helm-releases-error")).toBeNull();
});
