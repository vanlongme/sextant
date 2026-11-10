import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetHelmForTest, useHelm } from "../../stores/helm";
import { chart, chartVersion } from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { HelmChartDrawer } from "./HelmChartDrawer";

beforeEach(() => {
  resetHelmForTest();
  vi.setSystemTime(new Date("2027-01-01T10:00:00Z"));
  useHelm.setState({
    charts: {
      search: { charts: [chart({ name: "nginx" })], repoProblems: [] },
      error: null,
      loading: false,
    },
    repos: {
      list: [{ name: "bitnami", url: "https://charts.example/bitnami" }],
      error: null,
      updating: [],
    },
  });
});

afterEach(() => vi.useRealTimers());

function Location() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

async function show(
  handlers: Parameters<typeof mockBackend>[0],
  name = "nginx",
) {
  const backend = mockBackend(handlers);
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <HelmChartDrawer
        clusterId="c1"
        repo="bitnami"
        name={name}
        onClose={onClose}
      />
      <Location />
    </MemoryRouter>,
  );
  await act(flush);
  return { backend, onClose };
}

async function openTab(id: string) {
  fireEvent.mouseDown(screen.getByTestId(id), { button: 0 });
  await act(flush);
}

test("the README tab shows the facts and the rendered README of the latest version", async () => {
  const { backend } = await show({
    helm_chart_readme: () => "# nginx\n\nA **fast** server.",
  });
  expect(screen.getByText("Helm chart in bitnami")).toBeTruthy();
  const readme = screen.getByTestId("helm-chart-readme");
  expect(readme.textContent).toContain(
    "bitnami · https://charts.example/bitnami",
  );
  expect(readme.textContent).toContain("1.2.3 · app 1.25.0");
  // "# nginx" sits two levels down, under the drawer's headings.
  expect(
    within(readme).getByRole("heading", { level: 3, name: "nginx" }),
  ).toBeTruthy();
  expect(backend.callsTo("helm_chart_readme")).toEqual([
    { repo: "bitnami", chart: "nginx", version: "1.2.3" },
  ]);
});

test("an empty README says so", async () => {
  await show({ helm_chart_readme: () => "" });
  expect(screen.getByText("This chart has no README.")).toBeTruthy();
});

test("each tab loads when first shown, and only once", async () => {
  const { backend } = await show({
    helm_chart_readme: () => "text",
    helm_chart_values: () => "replicaCount: 1\n",
    helm_chart_versions: () => [],
  });
  expect(backend.callsTo("helm_chart_values")).toEqual([]);
  await openTab("helm-chart-tab-values");
  expect(screen.getByTestId("helm-chart-values").textContent).toBe(
    "replicaCount: 1\n",
  );
  expect(screen.getByRole("heading", { name: "Default values" })).toBeTruthy();
  await openTab("helm-chart-tab-readme");
  await openTab("helm-chart-tab-values");
  expect(backend.callsTo("helm_chart_values")).toHaveLength(1);
  expect(backend.callsTo("helm_chart_readme")).toHaveLength(1);
});

test("Versions lists them newest first, with Deprecated, and each installs its version", async () => {
  await show({
    helm_chart_readme: () => "text",
    helm_chart_versions: () => [
      chartVersion({ version: "1.2.3", created: "2026-12-30T10:00:00Z" }),
      chartVersion({ version: "1.2.2", deprecated: true, appVersion: null }),
    ],
  });
  await openTab("helm-chart-tab-versions");
  const cells = (id: string) =>
    Array.from(screen.getByTestId(id).querySelectorAll("td")).map(
      (c) => c.textContent,
    );
  expect(cells("helm-chart-version-1.2.3")).toEqual([
    "1.2.3",
    "1.25.0",
    "2d ago",
    "Install",
  ]);
  expect(cells("helm-chart-version-1.2.2").slice(0, 2)).toEqual([
    "1.2.2Deprecated",
    "—",
  ]);
  fireEvent.click(screen.getByTestId("helm-chart-version-install-1.2.2"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/install?repo=bitnami&chart=nginx&version=1.2.2",
  );
});

test("Install in the header opens the install page with the latest version", async () => {
  await show({ helm_chart_readme: () => "text" });
  fireEvent.click(screen.getByTestId("helm-chart-install"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/install?repo=bitnami&chart=nginx&version=1.2.3",
  );
});

test("a tab that fails shows the error with Retry inside it", async () => {
  let fail = true;
  const { backend } = await show({
    helm_chart_readme: () => {
      if (fail)
        throw { code: "Internal", message: "index gone", details: null };
      return "back";
    },
  });
  expect(screen.getByText("Could not read the README")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(backend.callsTo("helm_chart_readme")).toHaveLength(2);
  expect(screen.getByText("back")).toBeTruthy();
});

test("a chart that left the list says so, with no tabs and no Install", async () => {
  await show({}, "gone");
  expect(screen.getByTestId("helm-chart-missing").textContent).toBe(
    "The chart is not in any repository you have added.",
  );
  expect(screen.queryByTestId("helm-chart-install")).toBeNull();
  expect(screen.queryByTestId("helm-chart-tab-readme")).toBeNull();
});
