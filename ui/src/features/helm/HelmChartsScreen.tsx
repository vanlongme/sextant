import { Library } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Input,
  Spinner,
  type TableColumn,
  VirtualTable,
} from "../../design";
import type { ChartSummary } from "../../ipc/generated/ChartSummary";
import { isToolMissing, useHelm } from "../../stores/helm";
import { useClusterContext } from "../cluster/ClusterLayout";
import styles from "../resources/ResourceScreen.module.css";
import own from "./Helm.module.css";
import { HelmChartDrawer } from "./HelmChartDrawer";
import { HelmMissing } from "./HelmMissing";
import { pairParam, parsePair } from "./helmText";
import { Notice } from "./Notice";

/** Where "Repositories" and "Open Preferences" go (spec §12). */
export const REPOSITORIES_PATH = "/preferences#helm-repositories";

const PROBLEM_TEXT = {
  indexMissing: "its index is missing. Update it to see its charts.",
  indexInvalid: "its index could not be read. Update it to see its charts.",
};

const COLUMNS: TableColumn<ChartSummary>[] = [
  {
    id: "name",
    header: "Name",
    width: "minmax(160px, 1.5fr)",
    sortValue: (c) => c.name,
    render: (c) => c.name,
  },
  {
    id: "repo",
    header: "Repository",
    width: "minmax(120px, 1fr)",
    sortValue: (c) => c.repo,
    render: (c) => c.repo,
  },
  {
    id: "version",
    header: "Version",
    width: 168,
    render: (c) => (
      <span className={own.cellLine}>
        {c.latest.version}
        {c.latest.deprecated ? <Badge tone="warn">Deprecated</Badge> : null}
      </span>
    ),
  },
  {
    id: "app",
    header: "App version",
    width: 120,
    render: (c) => c.latest.appVersion ?? "—",
  },
  {
    id: "description",
    header: "Description",
    width: "minmax(200px, 3fr)",
    render: (c) => c.latest.description ?? "",
  },
];

export const chartKey = (c: { repo: string; name: string }) =>
  `${c.repo}/${c.name}`;

/** The charts of helm's repositories (spec §6). */
export function HelmChartsScreen({ clusterId }: { clusterId: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const search = useHelm((s) => s.charts.search);
  const error = useHelm((s) => s.charts.error);
  const repos = useHelm((s) => s.repos.list);
  const reposError = useHelm((s) => s.repos.error);
  const ensureCharts = useHelm((s) => s.ensureCharts);
  const ensureRepos = useHelm((s) => s.ensureRepos);
  const loadCharts = useHelm((s) => s.loadCharts);
  const loadRepos = useHelm((s) => s.loadRepos);
  const updateRepos = useHelm((s) => s.updateRepos);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void ensureCharts();
    void ensureRepos();
  }, [ensureCharts, ensureRepos]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (search?.charts ?? [])
      .filter(
        (c) =>
          needle === "" ||
          c.name.toLowerCase().includes(needle) ||
          c.repo.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo),
      );
  }, [search, query]);

  const opened = parsePair(params.get("chart"));
  const setChart = (value: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value === null) next.delete("chart");
      else next.set("chart", value);
      return next;
    });
  const openedKey = opened ? `${opened.first}/${opened.second}` : undefined;
  const openPrefs = () => {
    void navigate(REPOSITORIES_PATH);
  };

  let body: ReactNode;
  if (error && isToolMissing(error)) {
    body = (
      <HelmMissing
        message={error.message}
        onReady={() => {
          void loadCharts();
          void loadRepos();
        }}
      />
    );
  } else if (error) {
    body = (
      <ErrorNotice
        title="Could not read the chart repositories"
        message={error.message}
        details={error.details}
        onRetry={() => {
          void loadCharts();
        }}
      />
    );
  } else if (
    search === null ||
    (search.charts.length === 0 && repos === null && reposError === null)
  ) {
    body = <Spinner label="Loading charts" />;
  } else if (repos?.length === 0) {
    body = (
      <div data-testid="helm-charts-no-repos">
        <EmptyState
          title="No chart repositories yet."
          body="Add one in Preferences; SkoposIDE uses helm's own list, so it matches your CLI."
          action={
            <Button
              size="sm"
              onClick={openPrefs}
              data-testid="helm-charts-open-prefs"
            >
              Open Preferences
            </Button>
          }
        />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div data-testid="helm-charts-empty">
        <EmptyState
          title="No charts match."
          body="Search looks at chart names and repositories."
        />
      </div>
    );
  } else {
    body = (
      <VirtualTable
        rows={rows}
        columns={COLUMNS}
        rowKey={chartKey}
        rowTestId={(c) => `helm-chart-${c.repo}-${c.name}`}
        rowLabel={(c) => `${c.name} in ${c.repo}`}
        onRowClick={(c) => setChart(pairParam(c.repo, c.name))}
        activeKey={openedKey}
        testId="helm-charts-table"
      />
    );
  }

  return (
    <div className={styles.screen} data-testid="helm-charts-screen">
      <div className={styles.toolbar}>
        <h2 className={styles.title} data-testid="helm-charts-title">
          Charts
        </h2>
        {search ? (
          <span data-testid="helm-charts-count">
            <Badge tone="neutral">{rows.length}</Badge>
          </span>
        ) : null}
        <Input
          aria-label="Search charts by name or repository"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="helm-charts-search"
        />
        <div className={styles.grow} />
        <Button
          size="sm"
          variant="primary"
          onClick={openPrefs}
          data-testid="helm-charts-repos"
        >
          <Library size={14} aria-hidden="true" />
          Repositories
        </Button>
      </div>
      {error === null
        ? search?.repoProblems.map((p) => (
            <Notice
              key={p.repo}
              tone="warn"
              testId={`helm-repo-problem-${p.repo}`}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    void updateRepos([p.repo]);
                  }}
                >
                  Update {p.repo}
                </Button>
              }
            >
              {p.repo}: {PROBLEM_TEXT[p.problem]}
            </Notice>
          ))
        : null}
      <div className={styles.body}>
        <div className={styles.main}>{body}</div>
        {opened && error === null ? (
          <HelmChartDrawer
            key={openedKey}
            clusterId={clusterId}
            repo={opened.first}
            name={opened.second}
            onClose={() => setChart(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The route inside a connected cluster's layout. */
export function HelmChartsRoute() {
  const { clusterId } = useClusterContext();
  return <HelmChartsScreen key={clusterId} clusterId={clusterId} />;
}
