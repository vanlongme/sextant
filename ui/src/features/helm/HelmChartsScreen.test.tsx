import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ChartSearch } from "../../ipc/generated/ChartSearch";
import { resetHelmForTest } from "../../stores/helm";
import { chart, chartVersion, HELM_MISSING, toolStatus } from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { HelmChartsScreen } from "./HelmChartsScreen";

beforeEach(() => {
  resetHelmForTest();
  mockElementSize();
});

const REPOS = [
  { name: "bitnami", url: "https://charts.example/bitnami" },
  { name: "stable", url: "https://charts.example/stable" },
];
const SEARCH: ChartSearch = {
  charts: [
    chart({ name: "redis", latest: chartVersion({ appVersion: null }) }),
    chart({ name: "nginx", repo: "stable" }),
    chart({
      name: "nginx",
      latest: chartVersion({ version: "0.9.0", deprecated: true }),
    }),
  ],
  repoProblems: [],
};

function Location() {
  const { pathname, search, hash } = useLocation();
  return <span data-testid="location">{pathname + search + hash}</span>;
}

async function show(handlers: Parameters<typeof mockBackend>[0]) {
  const backend = mockBackend({
    helm_repo_list: () => REPOS,
    tools_status: () => [toolStatus({ tool: "helm" })],
    ...handlers,
  });
  render(
    <MemoryRouter initialEntries={["/cluster/c1/helm/charts"]}>
      <HelmChartsScreen clusterId="c1" />
      <Location />
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

const cells = (id: string) =>
  Array.from(screen.getByTestId(id).querySelectorAll("td")).map(
    (c) => c.textContent,
  );
const location = () => screen.getByTestId("location").textContent;
const rowIds = () =>
  [
    ...screen
      .getByTestId("helm-charts-table")
      .querySelectorAll("[data-testid^='helm-chart-']"),
  ].map((r) => r.getAttribute("data-testid"));

test("lists the charts by name, then repository, with their columns", async () => {
  await show({ helm_chart_search: () => SEARCH });
  expect(screen.getByTestId("helm-charts-title").textContent).toBe("Charts");
  expect(screen.getByTestId("helm-charts-count").textContent).toBe("3");
  expect(rowIds()).toEqual([
    "helm-chart-bitnami-nginx",
    "helm-chart-stable-nginx",
    "helm-chart-bitnami-redis",
  ]);
  expect(cells("helm-chart-bitnami-nginx")).toEqual([
    "nginx",
    "bitnami",
    "0.9.0Deprecated",
    "1.25.0",
    "A web server",
  ]);
  expect(cells("helm-chart-bitnami-redis")[3]).toBe("—");
});

test("search filters on the name and the repository, ignoring case", async () => {
  await show({ helm_chart_search: () => SEARCH });
  fireEvent.change(screen.getByTestId("helm-charts-search"), {
    target: { value: "STABLE" },
  });
  expect(rowIds()).toEqual(["helm-chart-stable-nginx"]);
  expect(screen.getByTestId("helm-charts-count").textContent).toBe("1");
  fireEvent.change(screen.getByTestId("helm-charts-search"), {
    target: { value: "red" },
  });
  expect(rowIds()).toEqual(["helm-chart-bitnami-redis"]);
  fireEvent.change(screen.getByTestId("helm-charts-search"), {
    target: { value: "zzz" },
  });
  expect(screen.getByTestId("helm-charts-empty").textContent).toBe(
    "No charts match.Search looks at chart names and repositories.",
  );
});

test("clicking a row opens its drawer through the URL, and closing it removes the parameter", async () => {
  await show({ helm_chart_search: () => SEARCH, helm_chart_readme: () => "" });
  fireEvent.click(screen.getByTestId("helm-chart-stable-nginx"));
  expect(location()).toBe("/cluster/c1/helm/charts?chart=stable%2Fnginx");
  expect(await screen.findByText("Helm chart in stable")).toBeTruthy();
  fireEvent.click(screen.getByTestId("helm-chart-drawer-close"));
  expect(location()).toBe("/cluster/c1/helm/charts");
  expect(screen.queryByTestId("helm-chart-drawer")).toBeNull();
});

test("a repository problem shows a notice whose button updates that repository", async () => {
  const backend = await show({
    helm_chart_search: () => ({
      charts: [],
      repoProblems: [
        { repo: "stable", problem: "indexMissing" },
        { repo: "bitnami", problem: "indexInvalid" },
      ],
    }),
    helm_repo_update: () => null,
  });
  expect(screen.getByTestId("helm-repo-problem-stable").textContent).toBe(
    "stable: its index is missing. Update it to see its charts.Update stable",
  );
  expect(screen.getByTestId("helm-repo-problem-bitnami").textContent).toContain(
    "bitnami: its index could not be read. Update it to see its charts.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Update stable" }));
  await act(flush);
  expect(backend.callsTo("helm_repo_update")).toEqual([{ names: ["stable"] }]);
});

test("Repositories opens Preferences at the Helm repositories section", async () => {
  await show({ helm_chart_search: () => SEARCH });
  fireEvent.click(screen.getByTestId("helm-charts-repos"));
  expect(location()).toBe("/preferences#helm-repositories");
});

test("without repositories it says so and opens Preferences", async () => {
  await show({
    helm_chart_search: () => ({ charts: [], repoProblems: [] }),
    helm_repo_list: () => [],
  });
  expect(screen.getByTestId("helm-charts-no-repos").textContent).toContain(
    "No chart repositories yet.Add one in Preferences; SkoposIDE uses helm's own list, so it matches your CLI.",
  );
  fireEvent.click(screen.getByTestId("helm-charts-open-prefs"));
  expect(location()).toBe("/preferences#helm-repositories");
});

test("loading shows a spinner", async () => {
  await show({ helm_chart_search: () => new Promise(() => {}) });
  expect(screen.getByRole("status", { name: "Loading charts" })).toBeTruthy();
});

test("a failure shows the error, and Retry reads again", async () => {
  let fail = true;
  const backend = await show({
    helm_chart_search: () => {
      if (fail)
        throw { code: "Internal", message: "index locked", details: null };
      return SEARCH;
    },
  });
  expect(
    screen.getByText("Could not read the chart repositories"),
  ).toBeTruthy();
  expect(screen.getByText("index locked")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(backend.callsTo("helm_chart_search")).toHaveLength(2);
  expect(rowIds()).toHaveLength(3);
});

test("missing helm shows the missing block instead of an error", async () => {
  await show({
    helm_chart_search: () => {
      throw HELM_MISSING;
    },
  });
  expect(screen.getByTestId("helm-missing")).toBeTruthy();
  expect(
    screen.queryByText("Could not read the chart repositories"),
  ).toBeNull();
});

test("charts still show when the repository list cannot be read", async () => {
  await show({
    helm_chart_search: () => SEARCH,
    helm_repo_list: () => {
      throw {
        code: "Internal",
        message: "repositories.yaml is locked",
        details: null,
      };
    },
  });
  expect(rowIds()).toHaveLength(3);
});
