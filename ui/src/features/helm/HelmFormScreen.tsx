import { ArrowRight, FileSearch, Play, Square } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  Button,
  ConfirmDialog,
  ErrorNotice,
  Input,
  Select,
  Spinner,
  Switch,
} from "../../design";
import { api } from "../../ipc/api";
import type { IpcFailure } from "../../ipc/client";
import type { HelmInstallRequest } from "../../ipc/generated/HelmInstallRequest";
import type { HelmPreview } from "../../ipc/generated/HelmPreview";
import type { HelmUpgradeRequest } from "../../ipc/generated/HelmUpgradeRequest";
import { asFailure, isToolMissing, runKey, useHelm } from "../../stores/helm";
import { useClusterContext } from "../cluster/ClusterLayout";
import { YamlEditor } from "../editor/YamlEditor";
import { CodeBlock } from "./CodeBlock";
import own from "./Helm.module.css";
import form from "./HelmForm.module.css";
import { HelmMissing } from "./HelmMissing";
import { chartsPath, releasesPath, versionText } from "./helmText";
import { Notice } from "./Notice";
import { useFetch } from "./useFetch";
import { useNamespaceSelection, useWatchReleases } from "./useReleases";

export type FormMode =
  | { kind: "install"; repo: string; chart: string; version: string | null }
  | { kind: "upgrade"; namespace: string; name: string };

type Shown =
  | { kind: "idle" }
  | { kind: "rendering" }
  | { kind: "preview"; preview: HelmPreview }
  | { kind: "previewFailed"; error: IpcFailure }
  | { kind: "run" };

function ErrorText(props: { message: string; details: string | null }) {
  return (
    <>
      <p className={form.error}>{props.message}</p>
      {props.details ? (
        <details className={form.details}>
          <summary>Details</summary>
          <pre>{props.details}</pre>
        </details>
      ) : null}
    </>
  );
}

/** The install and upgrade page (spec §10). */
export function HelmFormScreen(props: { clusterId: string; mode: FormMode }) {
  const { clusterId, mode } = props;
  const install = mode.kind === "install";
  const navigate = useNavigate();
  const search = useHelm((s) => s.charts.search);
  const chartsError = useHelm((s) => s.charts.error);
  const ensureCharts = useHelm((s) => s.ensureCharts);
  const loadCharts = useHelm((s) => s.loadCharts);
  const startInstall = useHelm((s) => s.startInstall);
  const startUpgrade = useHelm((s) => s.startUpgrade);
  const stopRun = useHelm((s) => s.stopRun);
  const showRunPage = useHelm((s) => s.showRunPage);
  const [selected, , selectionLoaded] = useNamespaceSelection(clusterId);
  useWatchReleases(
    clusterId,
    !install && selectionLoaded ? selected : undefined,
  );

  useEffect(() => {
    void ensureCharts();
  }, [ensureCharts]);

  // Upgrade: the release, and the repository its new version comes from.
  const release = useFetch(
    install ? null : `${mode.namespace}/${mode.name}`,
    () =>
      mode.kind === "upgrade"
        ? api.helmReleaseGet(clusterId, mode.namespace, mode.name)
        : Promise.reject(new Error("an install has no release")),
  );
  const gone = release.error?.code === "NotFound";
  const chartName = install ? mode.chart : (release.value?.chartName ?? null);
  const chartOptions = install
    ? []
    : (search?.charts ?? [])
        .filter((c) => chartName !== null && c.name === chartName)
        .sort((a, b) => a.repo.localeCompare(b.repo));
  const [repoChoice, setRepoChoice] = useState<string | null>(null);
  const repo = install
    ? mode.repo
    : ((chartOptions.find((c) => c.repo === repoChoice) ?? chartOptions[0])
        ?.repo ?? null);
  const chartMissing =
    !install &&
    release.value !== undefined &&
    (chartName === null || (search !== null && repo === null));

  // The versions and the chosen one.
  const versions = useFetch(
    repo !== null && chartName !== null ? `${repo}/${chartName}` : null,
    () => api.helmChartVersions(repo ?? "", chartName ?? ""),
  );
  const [versionChoice, setVersionChoice] = useState<string | null>(null);
  const preferred = install
    ? mode.version
    : (release.value?.chartVersion ?? null);
  const listed = versions.value ?? [];
  const version =
    listed.find((v) => v.version === versionChoice) ??
    listed.find((v) => v.version === preferred) ??
    listed[0] ??
    null;

  // The release name and namespace.
  const [nameText, setNameText] = useState(install ? mode.chart : mode.name);
  const [namespaceText, setNamespaceText] = useState<string | null>(
    install ? null : mode.namespace,
  );
  const releaseName = install ? nameText : mode.name;
  const namespace = install
    ? (namespaceText ??
      (selectionLoaded
        ? selected.length === 1
          ? (selected[0] ?? "default")
          : "default"
        : ""))
    : mode.namespace;
  const [createNamespace, setCreateNamespace] = useState(false);

  // The values: the chosen version's defaults (install) or the release's own (upgrade).
  const values = useFetch(
    install
      ? repo !== null && version !== null
        ? `${repo}/${mode.chart}/${version.version}`
        : null
      : `${mode.namespace}/${mode.name}`,
    () =>
      install
        ? api.helmChartValues(repo ?? "", mode.chart, version?.version ?? "")
        : api.helmReleaseValues(clusterId, mode.namespace, mode.name, false),
  );
  const [text, setText] = useState<string | null>(null);
  const loadedText = useRef<string | null>(null);
  useEffect(() => {
    if (values.value === undefined) return;
    const next = values.value;
    const before = loadedText.current;
    // Text still as loaded follows the new defaults; edited text is kept.
    setText((t) => (t === null || t === before ? next : t));
    loadedText.current = next;
  }, [values.value]);

  // The run this page shows: the one it started, or on upgrade the release's last one.
  const pageKey = runKey(clusterId, namespace, releaseName);
  const [runAt, setRunAt] = useState<{ key: string; id: number } | null>(() => {
    if (install) return null;
    const last = useHelm.getState().runs[pageKey];
    return last ? { key: last.key, id: last.id } : null;
  });
  const stored = useHelm((s) => (runAt ? s.runs[runAt.key] : undefined));
  const run = stored && runAt && stored.id === runAt.id ? stored : undefined;
  const running = run?.phase === "running";
  const shownKey = runAt?.key ?? pageKey;
  useEffect(() => showRunPage(shownKey), [showRunPage, shownKey]);

  const [shown, setShown] = useState<Shown>(() =>
    runAt ? { kind: "run" } : { kind: "idle" },
  );
  const previewSeq = useRef(0);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);

  /** Changing the chart or version clears a finished dry run or run. */
  const clearOutput = () => {
    previewSeq.current += 1;
    setShown((s) => (s.kind === "run" && running ? s : { kind: "idle" }));
  };

  const missing = [
    chartsError,
    release.error,
    versions.error,
    values.error,
  ].find((e) => e && isToolMissing(e));
  const blocked =
    shown.kind === "rendering" ||
    running ||
    versions.loading ||
    values.loading ||
    text === null ||
    version === null ||
    repo === null ||
    chartName === null ||
    gone ||
    chartMissing ||
    releaseName.trim() === "" ||
    namespace.trim() === "";

  const chartRef = () => ({
    repo: repo ?? "",
    chart: chartName ?? "",
    version: version?.version ?? "",
  });
  const installRequest = (): HelmInstallRequest => ({
    namespace: namespace.trim(),
    releaseName: releaseName.trim(),
    chart: chartRef(),
    values: text ?? "",
    createNamespace,
    wait: true,
  });
  const upgradeRequest = (): HelmUpgradeRequest => ({
    namespace,
    release: releaseName,
    chart: chartRef(),
    values: text ?? "",
    wait: true,
  });

  async function dryRun(): Promise<void> {
    previewSeq.current += 1;
    const mine = previewSeq.current;
    setShown({ kind: "rendering" });
    try {
      const preview = install
        ? await api.helmInstallPreview(clusterId, installRequest())
        : await api.helmUpgradePreview(clusterId, upgradeRequest());
      if (mine === previewSeq.current) setShown({ kind: "preview", preview });
    } catch (error) {
      if (mine === previewSeq.current) {
        setShown({ kind: "previewFailed", error: asFailure(error) });
      }
    }
  }

  function startRun(): void {
    previewSeq.current += 1;
    const key = runKey(clusterId, namespace.trim(), releaseName.trim());
    if (install) void startInstall(clusterId, installRequest());
    else void startUpgrade(clusterId, upgradeRequest());
    // The store records the run before its start call answers.
    const started = useHelm.getState().runs[key];
    if (started) setRunAt({ key, id: started.id });
    setShown({ kind: "run" });
  }

  const description = version?.description ?? null;
  const subtitle = (
    install
      ? [`Chart ${mode.repo}/${mode.chart}`, description]
      : [
          `Release in ${mode.namespace}`,
          chartName === null
            ? null
            : `chart ${repo === null ? chartName : `${repo}/${chartName}`}`,
          description,
        ]
  )
    .filter((part) => part)
    .join(" · ");

  let status: ReactNode;
  let area: ReactNode = null;
  if (shown.kind === "run" && run) {
    if (!run.rejected) {
      area = (
        <pre
          className={form.log}
          role="log"
          aria-label="helm output"
          data-testid="helm-form-output"
        >
          {run.output}
        </pre>
      );
    }
    if (run.phase === "running") {
      status = (
        <>
          <Spinner />
          <span data-testid="helm-form-status">
            {install ? "Installing" : "Upgrading"}
          </span>
        </>
      );
    } else if (run.phase === "succeeded") {
      status = (
        <>
          <span data-testid="helm-form-status">
            {install ? "Installed." : "Upgraded."}
          </span>
          <Button
            size="sm"
            onClick={() => {
              void navigate(
                releasesPath(clusterId, {
                  namespace: run.namespace,
                  name: run.release,
                }),
              );
            }}
            data-testid="helm-form-open-release"
          >
            Open the release
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        </>
      );
    } else if (run.phase === "failed") {
      status = (
        <span data-testid="helm-form-status">
          {run.rejected ? "Failed." : "Failed. helm wrote the error above."}
        </span>
      );
      area = (
        <>
          {area}
          {run.error ? (
            <ErrorText
              message={run.error.message}
              details={run.error.details}
            />
          ) : null}
        </>
      );
    } else {
      status = (
        <span data-testid="helm-form-status">
          Stopped. {run.release} may be left failed or pending; check it in
          Releases.
        </span>
      );
    }
  } else if (shown.kind === "rendering") {
    status = (
      <>
        <Spinner />
        <span data-testid="helm-form-status">Rendering</span>
      </>
    );
  } else if (shown.kind === "preview") {
    status = (
      <span data-testid="helm-form-status">
        Dry run finished; nothing was changed.
      </span>
    );
    area = (
      <>
        <CodeBlock
          title="Manifest"
          text={shown.preview.manifest}
          testId="helm-form-preview-manifest"
        />
        {shown.preview.notes !== null ? (
          <CodeBlock
            title="Notes"
            text={shown.preview.notes}
            testId="helm-form-preview-notes"
          />
        ) : null}
      </>
    );
  } else if (shown.kind === "previewFailed") {
    status = <span data-testid="helm-form-status">Failed.</span>;
    area = (
      <ErrorText
        message={shown.error.message}
        details={shown.error.details ?? null}
      />
    );
  } else {
    status = (
      <span data-testid="helm-form-status">
        Dry run renders the manifests on the server and changes nothing.{" "}
        {install ? "Install" : "Upgrade"} streams helm's output here, and its
        errors verbatim.
      </span>
    );
  }

  const failure =
    (release.error && !gone ? release.error : null) ??
    versions.error ??
    values.error;
  const failureTitle =
    release.error && !gone
      ? "Could not read the release"
      : versions.error
        ? "Could not read the chart versions"
        : "Could not read the values";

  return (
    <div className={form.form} data-testid="helm-form">
      <div className={form.header}>
        <div className={form.heading}>
          <h2 className={form.title} data-testid="helm-form-title">
            {install ? `Install ${mode.chart}` : `Upgrade ${mode.name}`}
          </h2>
          <p className={form.subtitle}>{subtitle}</p>
        </div>
        <div className={form.buttons}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigate(
                install
                  ? chartsPath(clusterId, { repo: mode.repo, name: mode.chart })
                  : releasesPath(clusterId, {
                      namespace: mode.namespace,
                      name: mode.name,
                    }),
              );
            }}
            data-testid="helm-form-cancel"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={blocked}
            onClick={() => {
              void dryRun();
            }}
            data-testid="helm-form-dry-run"
          >
            <FileSearch size={14} aria-hidden="true" />
            Dry run
          </Button>
          {running ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => setStopping(true)}
              data-testid="helm-form-stop"
            >
              <Square size={14} aria-hidden="true" />
              Stop
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={blocked}
            onClick={() => {
              if (install) startRun();
              else setConfirming(true);
            }}
            data-testid="helm-form-submit"
          >
            <Play size={14} aria-hidden="true" />
            {running
              ? install
                ? "Installing"
                : "Upgrading"
              : install
                ? "Install"
                : "Upgrade"}
          </Button>
        </div>
      </div>

      {missing ? (
        <HelmMissing
          message={missing.message}
          onReady={() => {
            void loadCharts();
            release.retry();
            versions.retry();
            values.retry();
          }}
        />
      ) : null}
      {!missing && gone ? (
        <Notice tone="warn" testId="helm-form-missing">
          {`The release ${namespace}/${releaseName} is gone; it may have been uninstalled.`}
        </Notice>
      ) : null}
      {!missing && !gone && chartMissing ? (
        <Notice tone="warn" testId="helm-form-missing">
          The chart is not in any repository you have added.
        </Notice>
      ) : null}
      {!missing && failure ? (
        <ErrorNotice
          title={failureTitle}
          message={failure.message}
          details={failure.details}
          onRetry={() => {
            release.retry();
            versions.retry();
            values.retry();
          }}
        />
      ) : null}

      <div className={form.fields}>
        {!install && chartOptions.length > 0 && repo !== null ? (
          <Select
            label="Chart"
            value={repo}
            options={chartOptions.map((c) => ({
              value: c.repo,
              label: `${c.repo}/${c.name}`,
            }))}
            onChange={(next) => {
              setRepoChoice(next);
              setVersionChoice(null);
              clearOutput();
            }}
            testId="helm-form-chart"
          />
        ) : null}
        {version !== null ? (
          <Select
            label="Chart version"
            value={version.version}
            options={listed.map((v) => ({
              value: v.version,
              label: versionText(v.version, v.appVersion),
            }))}
            onChange={(next) => {
              setVersionChoice(next);
              clearOutput();
            }}
            testId="helm-form-version"
          />
        ) : versions.loading ? (
          <Spinner />
        ) : null}
        <Input
          label="Release name"
          className={own.mono}
          value={releaseName}
          disabled={!install}
          onChange={(e) => setNameText(e.target.value)}
          data-testid="helm-form-name"
        />
        <Input
          label="Namespace"
          className={own.mono}
          value={namespace}
          disabled={!install}
          onChange={(e) => setNamespaceText(e.target.value)}
          data-testid="helm-form-namespace"
        />
        {install ? (
          <Switch
            label="Create the namespace"
            description="--create-namespace"
            checked={createNamespace}
            onChange={setCreateNamespace}
            testId="helm-form-create-namespace"
          />
        ) : null}
      </div>

      <section className={form.section}>
        <h3 className={form.sectionTitle}>Values</h3>
        <p className={form.caption}>
          YAML merged over the chart defaults, passed as --values
        </p>
        <div className={form.editor}>
          <YamlEditor
            value={text ?? ""}
            onChange={setText}
            testId="helm-form-values"
          />
        </div>
      </section>

      <section className={form.section}>
        <h3 className={form.sectionTitle}>Output</h3>
        <div className={form.status}>{status}</div>
        {area}
      </section>

      <ConfirmDialog
        open={confirming}
        title={`Upgrade ${releaseName}?`}
        body={`helm upgrade applies ${repo ?? ""}/${chartName ?? ""} ${version?.version ?? ""} with the values on this page to ${releaseName} in ${namespace}. It runs with --wait, and the objects change as the new revision applies.`}
        confirmLabel="Upgrade"
        testId="helm-upgrade-dialog"
        onConfirm={() => {
          setConfirming(false);
          startRun();
        }}
        onCancel={() => setConfirming(false)}
      />
      <ConfirmDialog
        open={stopping}
        title="Stop helm?"
        body={`helm stops where it is. ${releaseName} may be left failed, pending-install or pending-upgrade; roll it back or upgrade it again afterwards.`}
        confirmLabel="Stop"
        cancelLabel="Keep running"
        danger
        testId="helm-stop-dialog"
        onConfirm={() => {
          setStopping(false);
          if (runAt) stopRun(runAt.key);
        }}
        onCancel={() => setStopping(false)}
      />
    </div>
  );
}

/** `helm/install?repo=…&chart=…&version=…` inside a connected cluster's layout. */
export function HelmInstallRoute() {
  const { clusterId } = useClusterContext();
  const [params] = useSearchParams();
  const repo = params.get("repo");
  const chart = params.get("chart");
  const version = params.get("version");
  if (!repo || !chart) return <Navigate to={chartsPath(clusterId)} replace />;
  return (
    <HelmFormScreen
      key={`${clusterId}/${repo}/${chart}/${version ?? ""}`}
      clusterId={clusterId}
      mode={{ kind: "install", repo, chart, version }}
    />
  );
}

/** `helm/upgrade/:namespace/:name` inside a connected cluster's layout. */
export function HelmUpgradeRoute() {
  const { clusterId } = useClusterContext();
  const { namespace = "", name = "" } = useParams();
  return (
    <HelmFormScreen
      key={`${clusterId}/${namespace}/${name}`}
      clusterId={clusterId}
      mode={{ kind: "upgrade", namespace, name }}
    />
  );
}
