import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { NAV_SECTIONS } from "../../kinds/nav";
import { flush, mockBackend } from "../../test/ipc";
import { Sidebar } from "./Sidebar";

function info(
  group: string,
  plural: string,
  kind = plural,
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
    canDelete: true,
  };
}

const SERVED = [
  info("", "pods", "Pod"),
  info("apps", "deployments", "Deployment"),
  info("apiextensions.k8s.io", "customresourcedefinitions"),
  info("acme.io", "gadgets", "Gadget"),
];

async function show(
  props: Partial<Parameters<typeof Sidebar>[0]> = {},
  path = "/cluster/c1",
  handlers: Record<string, (a: never) => unknown> = {},
) {
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    ...handlers,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar
        clusterId="c1"
        resources={SERVED}
        loading={false}
        error={null}
        onRetry={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

test("shows the visible sections and items", async () => {
  await show();
  expect(screen.getByTestId("cluster-sidebar")).toBeTruthy();
  expect(screen.getByTestId("nav-section-workloads")).toBeTruthy();
  expect(screen.getByTestId("nav-overview-workloads")).toBeTruthy();
  expect(screen.getByTestId("nav-item-core-pods")).toBeTruthy();
  expect(screen.getByTestId("nav-item-apps-deployments")).toBeTruthy();
  expect(screen.queryByTestId("nav-section-network")).toBeNull();
  expect(screen.queryByTestId("nav-item-batch-jobs")).toBeNull();
  const group = screen.getByTestId("nav-crd-group-acme.io");
  expect(within(group).getByTestId("nav-item-acme.io-gadgets")).toBeTruthy();
});

test("the active item is marked with aria-current", async () => {
  await show({}, "/cluster/c1/r/apps/deployments");
  expect(
    screen
      .getByTestId("nav-item-apps-deployments")
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(
    screen.getByTestId("nav-item-core-pods").getAttribute("aria-current"),
  ).toBeNull();
  expect(
    screen.getByTestId("nav-overview").getAttribute("aria-current"),
  ).toBeNull();
});

test("Overview is active on the cluster home", async () => {
  await show();
  expect(screen.getByTestId("nav-overview").getAttribute("aria-current")).toBe(
    "page",
  );
});

test("collapsing a section is saved through the UI state", async () => {
  const backend = await show();
  const toggle = within(screen.getByTestId("nav-section-workloads")).getByRole(
    "button",
    { name: "Workloads" },
  );
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  vi.useFakeTimers();
  fireEvent.click(toggle);
  act(() => {
    vi.advanceTimersByTime(300);
  });
  vi.useRealTimers();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(backend.callsTo("ui_state_set")).toContainEqual({
    key: "cluster.c1.nav.workloads",
    value: false,
  });
});

test("a saved collapsed section stays collapsed", async () => {
  await show({}, "/cluster/c1", {
    ui_state_get: ((a: { key: string }) =>
      a.key === "cluster.c1.nav.workloads" ? false : null) as never,
  });
  const toggle = within(screen.getByTestId("nav-section-workloads")).getByRole(
    "button",
    { name: "Workloads" },
  );
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

test("shows a loading state", async () => {
  await show({ resources: [], loading: true });
  expect(
    screen.getByRole("status", { name: "Loading resources" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("nav-section-workloads")).toBeNull();
});

test("shows the error with a retry", async () => {
  const onRetry = vi.fn();
  await show({ resources: [], error: "boom", onRetry });
  expect(screen.getByRole("alert").textContent).toContain("boom");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalled();
});

test("a failed refresh keeps the navigation and shows the error with a retry", async () => {
  const onRetry = vi.fn();
  await show({ error: "boom", onRetry });
  expect(screen.getByTestId("nav-section-workloads")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("boom");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalled();
});

test("Custom Resources lists Definitions before the CRD groups", async () => {
  await show();
  const section = screen.getByTestId("nav-section-custom");
  const links = within(section).getAllByRole("link");
  expect(links.map((l) => l.getAttribute("data-testid"))).toEqual([
    "nav-item-apiextensions.k8s.io-customresourcedefinitions",
    "nav-item-acme.io-gadgets",
  ]);
});

test("without list access to definitions, CRD groups still show", async () => {
  await show({
    resources: [
      info("apiextensions.k8s.io", "customresourcedefinitions", "CRD", false),
      info("acme.io", "gadgets", "Gadget"),
    ],
  });
  expect(
    screen.queryByTestId(
      "nav-item-apiextensions.k8s.io-customresourcedefinitions",
    ),
  ).toBeNull();
  expect(screen.getByTestId("nav-item-acme.io-gadgets")).toBeTruthy();
});

test("every nav section id is distinct", () => {
  const ids = NAV_SECTIONS.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
});
