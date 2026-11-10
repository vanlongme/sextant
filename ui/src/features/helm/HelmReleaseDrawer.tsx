import { CircleArrowUp, History, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
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
import type { HelmRelease } from "../../ipc/generated/HelmRelease";
import type { HelmReleaseDetail } from "../../ipc/generated/HelmReleaseDetail";
import type { HelmRevision } from "../../ipc/generated/HelmRevision";
import type { ManifestResource } from "../../ipc/generated/ManifestResource";
import { releaseIsBusy, runKey, useHelm } from "../../stores/helm";
import { CopyRow } from "../details/CopyRow";
import drawer from "../details/DetailDrawer.module.css";
import { CodeBlock } from "./CodeBlock";
import { DrawerFrame } from "./DrawerFrame";
import own from "./Helm.module.css";
import {
  ago,
  namespacePath,
  objectPath,
  releaseActions,
  statusTone,
  upgradePath,
  utcTime,
} from "./helmText";
import { Notice } from "./Notice";
import { RollbackDialog, UninstallDialog } from "./ReleaseDialogs";
import { type Fetched, useFetch } from "./useFetch";
import { useSeenTab } from "./useSeenTab";

type ReleaseTab = "overview" | "values" | "manifest" | "history";
type Dialog = { kind: "rollback"; revision?: number } | { kind: "uninstall" };

/**
 * A number that grows each time `stamp` changes once `ready`, so the drawer reads
 * again when the list shows a new revision or status, but not on the list's first answer.
 */
function useChanges(ready: boolean, stamp: string): number {
  const [changes, setChanges] = useState(0);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (last.current !== null && last.current !== stamp) {
      setChanges((n) => n + 1);
    }
    last.current = stamp;
  }, [ready, stamp]);
  return changes;
}

function Pending<T>(props: { fetched: Fetched<T>; title: string }) {
  const { fetched } = props;
  if (fetched.error) {
    return (
      <ErrorNotice
        title={props.title}
        message={fetched.error.message}
        details={fetched.error.details}
        onRetry={fetched.retry}
      />
    );
  }
  return fetched.value === undefined ? <Spinner /> : null;
}

/** The note on a failed release (spec §9). */
function failedText(
  detail: HelmReleaseDetail,
  history: HelmRevision[],
): string {
  const what = detail.revision === 1 ? "install" : "upgrade";
  const first = detail.description
    ? `The last ${what} failed: ${detail.description}.`
    : `The last ${what} failed.`;
  const back = history.find(
    (r) =>
      r.revision < detail.revision &&
      (r.status === "deployed" || r.status === "superseded"),
  );
  return back
    ? `${first} Roll back to revision ${back.revision}, or fix the values and upgrade again.`
    : `${first} Fix the values and upgrade again.`;
}

/** One release, with its overview, values, manifest and history (spec §9). */
export function HelmReleaseDrawer(props: {
  clusterId: string;
  namespace: string;
  name: string;
  /** The release in the list, which drives the reloads; undefined when it left the list. */
  listed: HelmRelease | undefined;
  /** Whether the list has answered, so its changes count. */
  listLoaded: boolean;
  onClose(): void;
}) {
  const { clusterId, namespace, name, listed, onClose } = props;
  const navigate = useNavigate();
  const now = useNow();
  const loadReleases = useHelm((s) => s.loadReleases);
  const run = useHelm((s) => s.runs[runKey(clusterId, namespace, name)]);
  const [tab, setTab, seen] = useSeenTab<ReleaseTab>("overview");
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // Opening the drawer reads the list again; on a first load the screen's watch reads it.
  useEffect(() => {
    if (useHelm.getState().releases[clusterId]) void loadReleases(clusterId);
  }, [loadReleases, clusterId]);

  const changes = useChanges(
    props.listLoaded,
    listed ? `${listed.revision}/${listed.status}` : "gone",
  );
  const key = `${namespace}/${name}#${changes}`;
  const detail = useFetch(key, () =>
    api.helmReleaseGet(clusterId, namespace, name),
  );
  const history = useFetch(key, () =>
    api.helmReleaseHistory(clusterId, namespace, name),
  );
  const userValues = useFetch(seen("values") ? key : null, () =>
    api.helmReleaseValues(clusterId, namespace, name, false),
  );
  const computedValues = useFetch(seen("values") ? key : null, () =>
    api.helmReleaseValues(clusterId, namespace, name, true),
  );

  const gone = detail.error?.code === "NotFound";
  const shown = detail.value;
  const status = listed?.status ?? shown?.status ?? null;
  const current = shown?.revision ?? listed?.revision ?? 0;
  const revisions = history.value ?? [];
  const actions =
    status === null || gone
      ? { upgrade: false, rollback: false, uninstall: false }
      : releaseActions({ status }, run, revisions.length);

  const resourceColumns: Column<ManifestResource>[] = [
    { id: "kind", header: "Kind", render: (r) => r.kind },
    {
      id: "name",
      header: "Name",
      render: (r) =>
        r.ref ? (
          <Link
            className={drawer.link}
            to={objectPath(clusterId, r.ref, r.namespace, r.name)}
          >
            {r.name}
          </Link>
        ) : (
          r.name
        ),
    },
    { id: "namespace", header: "Namespace", render: (r) => r.namespace ?? "—" },
  ];

  const historyColumns: Column<HelmRevision>[] = [
    { id: "revision", header: "Revision", render: (r) => String(r.revision) },
    { id: "updated", header: "Updated", render: (r) => ago(r.updated, now) },
    {
      id: "status",
      header: "Status",
      render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
    },
    { id: "chart", header: "Chart", render: (r) => r.chart },
    { id: "app", header: "App version", render: (r) => r.appVersion ?? "—" },
    { id: "description", header: "Description", render: (r) => r.description },
    {
      id: "rollback",
      header: "",
      render: (r) =>
        actions.rollback && r.revision !== current ? (
          <button
            type="button"
            className={drawer.link}
            onClick={() =>
              setDialog({ kind: "rollback", revision: r.revision })
            }
            data-testid={`helm-release-revision-rollback-${r.revision}`}
          >
            Roll back
          </button>
        ) : null,
    },
  ];

  let content = null;
  if (gone) {
    content = (
      <p className={drawer.muted} data-testid="helm-release-gone">
        The release {namespace}/{name} is gone; it may have been uninstalled.
      </p>
    );
  } else if (!shown) {
    content = <Pending fetched={detail} title="Could not read the release" />;
  } else if (tab === "overview") {
    const busy = status !== null && releaseIsBusy({ status }, run);
    content = (
      <>
        {status === "uninstalled" ? (
          <Notice tone="neutral" testId="helm-release-uninstalled">
            helm uninstalled this release and kept its history. Its objects are
            gone; roll it back from the CLI to bring it back, or uninstall it
            again to delete the history.
          </Notice>
        ) : null}
        {status === "failed" && !busy ? (
          <Notice tone="danger" testId="helm-release-failed">
            {failedText(shown, revisions)}
          </Notice>
        ) : null}
        {busy ? (
          <Notice tone="warn" testId="helm-release-busy">
            {shown.description
              ? `helm is working on this release: ${shown.description}. Its actions come back when it finishes.`
              : "helm is working on this release. Its actions come back when it finishes."}
          </Notice>
        ) : null}
        <section className={drawer.section} data-testid="helm-release-facts">
          <h4 className={drawer.heading}>Release</h4>
          <dl className={drawer.facts}>
            <CopyRow label="Status">{shown.status}</CopyRow>
            <CopyRow label="Chart">
              <span className={own.mono}>
                {shown.chartName !== null && shown.chartVersion !== null
                  ? `${shown.chartName} ${shown.chartVersion}`
                  : shown.chart}
              </span>
            </CopyRow>
            <CopyRow label="App version">{shown.appVersion ?? "—"}</CopyRow>
            <CopyRow label="Revision">{String(shown.revision)}</CopyRow>
            <CopyRow label="Namespace">
              <Link
                className={drawer.link}
                to={namespacePath(clusterId, namespace)}
              >
                {namespace}
              </Link>
            </CopyRow>
            <CopyRow label="First deployed">
              {utcTime(shown.firstDeployed, now)}
            </CopyRow>
            <CopyRow label="Last deployed">
              {utcTime(shown.lastDeployed, now)}
            </CopyRow>
          </dl>
        </section>
        {shown.notes ? (
          <CodeBlock
            title="Notes"
            text={shown.notes}
            testId="helm-release-notes"
          />
        ) : null}
        <section className={drawer.section}>
          <h4 className={drawer.heading}>Resources</h4>
          <DataTable
            rows={shown.resources}
            columns={resourceColumns}
            rowKey={(r) => `${r.apiVersion}/${r.kind}/${r.namespace}/${r.name}`}
            testId="helm-release-resources"
          />
        </section>
      </>
    );
  } else if (tab === "values") {
    content = (
      <>
        <Pending fetched={userValues} title="Could not read the values" />
        {userValues.value !== undefined ? (
          <CodeBlock
            title="User-supplied values"
            text={
              userValues.value.trim() === ""
                ? "# none: the chart defaults apply"
                : userValues.value
            }
            testId="helm-release-user-values"
          />
        ) : null}
        <Pending fetched={computedValues} title="Could not read the values" />
        {computedValues.value !== undefined ? (
          <CodeBlock
            title="Computed values"
            text={computedValues.value}
            testId="helm-release-computed-values"
          />
        ) : null}
      </>
    );
  } else if (tab === "manifest") {
    content =
      shown.manifest === "" ? (
        <p className={drawer.muted} data-testid="helm-release-manifest-empty">
          helm has no manifest for this revision.
        </p>
      ) : (
        <CodeBlock
          title={`Manifest of revision ${shown.revision}`}
          text={shown.manifest}
          testId="helm-release-manifest"
        />
      );
  } else {
    content = (
      <>
        <Pending fetched={history} title="Could not read the release history" />
        {history.value ? (
          <section className={drawer.section}>
            <h4 className={drawer.heading}>History</h4>
            <DataTable
              rows={history.value}
              columns={historyColumns}
              rowKey={(r) => String(r.revision)}
              rowTestId={(r) => `helm-release-revision-${r.revision}`}
              testId="helm-release-history"
            />
          </section>
        ) : null}
      </>
    );
  }

  const tabs = [
    {
      value: "overview",
      label: "Overview",
      testId: "helm-release-tab-overview",
    },
    { value: "values", label: "Values", testId: "helm-release-tab-values" },
    {
      value: "manifest",
      label: "Manifest",
      testId: "helm-release-tab-manifest",
    },
    {
      value: "history",
      label: history.value ? `History (${history.value.length})` : "History",
      testId: "helm-release-tab-history",
    },
  ];

  return (
    <DrawerFrame
      label="Release details"
      testId="helm-release-drawer"
      title={name}
      kind={`Helm release in ${namespace}`}
      onClose={onClose}
      extra={
        status !== null && !gone ? (
          <span data-testid="helm-release-drawer-status">
            <Badge tone={statusTone(status)}>{status}</Badge>
          </span>
        ) : null
      }
      actions={
        <>
          {actions.upgrade ? (
            <Button
              size="sm"
              onClick={() => {
                void navigate(upgradePath(clusterId, namespace, name));
              }}
              data-testid="helm-release-upgrade"
            >
              <CircleArrowUp size={14} aria-hidden="true" />
              Upgrade
            </Button>
          ) : null}
          {actions.rollback ? (
            <Button
              size="sm"
              onClick={() => setDialog({ kind: "rollback" })}
              data-testid="helm-release-rollback"
            >
              <History size={14} aria-hidden="true" />
              Roll back
            </Button>
          ) : null}
          {actions.uninstall ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => setDialog({ kind: "uninstall" })}
              data-testid="helm-release-uninstall"
            >
              <Trash2 size={14} aria-hidden="true" />
              Uninstall
            </Button>
          ) : null}
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={(v) => setTab(v as ReleaseTab)}
        tabs={gone ? [] : tabs}
      />
      <div className={drawer.content}>{content}</div>
      {dialog?.kind === "rollback" ? (
        <RollbackDialog
          clusterId={clusterId}
          namespace={namespace}
          name={name}
          current={current}
          revision={dialog.revision}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "uninstall" && status !== null ? (
        <UninstallDialog
          clusterId={clusterId}
          namespace={namespace}
          name={name}
          status={status}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </DrawerFrame>
  );
}
