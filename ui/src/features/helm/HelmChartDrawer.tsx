import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  type Column,
  DataTable,
  ErrorNotice,
  Spinner,
  Tabs,
  useNow,
} from "../../design";
import { api } from "../../ipc/api";
import type { ChartVersion } from "../../ipc/generated/ChartVersion";
import { useHelm } from "../../stores/helm";
import { CopyRow } from "../details/CopyRow";
import drawer from "../details/DetailDrawer.module.css";
import { CodeBlock } from "./CodeBlock";
import { DrawerFrame } from "./DrawerFrame";
import own from "./Helm.module.css";
import { ago, installPath, versionText } from "./helmText";
import { Markdown } from "./Markdown";
import { type Fetched, useFetch } from "./useFetch";
import { useSeenTab } from "./useSeenTab";

type ChartTab = "readme" | "values" | "versions";

const TABS = [
  { value: "readme", label: "README", testId: "helm-chart-tab-readme" },
  { value: "values", label: "Values", testId: "helm-chart-tab-values" },
  { value: "versions", label: "Versions", testId: "helm-chart-tab-versions" },
];

/** A tab's spinner or error; null once its value is there. */
function Pending<T>({
  fetched,
  title,
}: {
  fetched: Fetched<T>;
  title: string;
}) {
  if (fetched.error) {
    return (
      <ErrorNotice
        title={title}
        message={fetched.error.message}
        details={fetched.error.details}
        onRetry={fetched.retry}
      />
    );
  }
  return fetched.value === undefined ? <Spinner /> : null;
}

/** One chart of the list, with its README, default values and versions (spec §7). */
export function HelmChartDrawer(props: {
  clusterId: string;
  repo: string;
  name: string;
  onClose(): void;
}) {
  const { clusterId, repo, name, onClose } = props;
  const navigate = useNavigate();
  const now = useNow();
  const chart = useHelm((s) =>
    s.charts.search?.charts.find((c) => c.repo === repo && c.name === name),
  );
  const url = useHelm((s) => s.repos.list?.find((r) => r.name === repo)?.url);
  const [tab, setTab, seen] = useSeenTab<ChartTab>("readme");
  const latest = chart?.latest.version ?? null;
  const at = (t: ChartTab) =>
    latest !== null && seen(t) ? `${repo}/${name}/${latest}` : null;
  const readme = useFetch(at("readme"), () =>
    api.helmChartReadme(repo, name, latest ?? ""),
  );
  const values = useFetch(at("values"), () =>
    api.helmChartValues(repo, name, latest ?? ""),
  );
  const versions = useFetch(seen("versions") ? `${repo}/${name}` : null, () =>
    api.helmChartVersions(repo, name),
  );

  const install = (version: string) => {
    void navigate(installPath(clusterId, repo, name, version));
  };

  const columns: Column<ChartVersion>[] = [
    {
      id: "version",
      header: "Version",
      render: (v) => (
        <span className={own.cellLine}>
          {v.version}
          {v.deprecated ? <Badge tone="warn">Deprecated</Badge> : null}
        </span>
      ),
    },
    { id: "app", header: "App version", render: (v) => v.appVersion ?? "—" },
    { id: "released", header: "Released", render: (v) => ago(v.created, now) },
    {
      id: "install",
      header: "",
      render: (v) => (
        <button
          type="button"
          className={drawer.link}
          onClick={() => install(v.version)}
          data-testid={`helm-chart-version-install-${v.version}`}
        >
          Install
        </button>
      ),
    },
  ];

  let content = null;
  if (!chart) {
    content = (
      <p className={drawer.muted} data-testid="helm-chart-missing">
        The chart is not in any repository you have added.
      </p>
    );
  } else if (tab === "readme") {
    content = (
      <div data-testid="helm-chart-readme">
        <section className={drawer.section}>
          <h4 className={drawer.heading}>Chart</h4>
          <dl className={drawer.facts}>
            <CopyRow label="Repository">
              <span className={own.mono}>
                {url ? `${repo} · ${url}` : repo}
              </span>
            </CopyRow>
            <CopyRow label="Latest">
              {versionText(chart.latest.version, chart.latest.appVersion)}
            </CopyRow>
          </dl>
        </section>
        <Pending fetched={readme} title="Could not read the README" />
        {readme.value === "" ? (
          <p className={drawer.muted}>This chart has no README.</p>
        ) : null}
        {readme.value ? <Markdown text={readme.value} /> : null}
      </div>
    );
  } else if (tab === "values") {
    content = (
      <>
        <Pending fetched={values} title="Could not read the default values" />
        {values.value !== undefined ? (
          <CodeBlock
            title="Default values"
            text={values.value}
            testId="helm-chart-values"
          />
        ) : null}
      </>
    );
  } else {
    content = (
      <>
        <Pending fetched={versions} title="Could not read the chart versions" />
        {versions.value ? (
          <section className={drawer.section}>
            <h4 className={drawer.heading}>Versions</h4>
            <DataTable
              rows={versions.value}
              columns={columns}
              rowKey={(v) => v.version}
              rowTestId={(v) => `helm-chart-version-${v.version}`}
              testId="helm-chart-versions"
            />
          </section>
        ) : null}
      </>
    );
  }

  return (
    <DrawerFrame
      label="Chart details"
      testId="helm-chart-drawer"
      title={name}
      kind={`Helm chart in ${repo}`}
      onClose={onClose}
      actions={
        chart ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => install(chart.latest.version)}
            data-testid="helm-chart-install"
          >
            Install
          </Button>
        ) : null
      }
    >
      <Tabs
        value={tab}
        onChange={(v) => setTab(v as ChartTab)}
        tabs={chart ? TABS : []}
      />
      <div className={drawer.content}>{content}</div>
    </DrawerFrame>
  );
}
