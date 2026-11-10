import {
  CircleArrowUp,
  Ellipsis,
  History,
  PackagePlus,
  Trash2,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Input,
  Menu,
  Spinner,
  type TableColumn,
  useNow,
  VirtualTable,
} from "../../design";
import type { HelmRelease } from "../../ipc/generated/HelmRelease";
import {
  type HelmRun,
  isToolMissing,
  runKey,
  useHelm,
} from "../../stores/helm";
import { useClusterContext } from "../cluster/ClusterLayout";
import { NamespaceFilter } from "../resources/NamespaceFilter";
import styles from "../resources/ResourceScreen.module.css";
import { HelmMissing } from "./HelmMissing";
import { HelmReleaseDrawer } from "./HelmReleaseDrawer";
import {
  ago,
  chartsPath,
  pairParam,
  parsePair,
  releaseActions,
  statusTone,
  upgradePath,
} from "./helmText";
import { Notice } from "./Notice";
import { RollbackDialog, UninstallDialog } from "./ReleaseDialogs";
import {
  useClusterNamespaces,
  useNamespaceSelection,
  useWatchReleases,
} from "./useReleases";

type Dialog = { kind: "rollback" | "uninstall"; release: HelmRelease };

const releaseKey = (r: { namespace: string; name: string }) =>
  `${r.namespace}/${r.name}`;

/** The releases of the selected namespaces (spec §8). */
export function HelmReleasesScreen({ clusterId }: { clusterId: string }) {
  const navigate = useNavigate();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected, selectionLoaded] =
    useNamespaceSelection(clusterId);
  const slice = useWatchReleases(
    clusterId,
    selectionLoaded ? selected : undefined,
  );
  const clusterNamespaces = useClusterNamespaces(clusterId);
  const loadReleases = useHelm((s) => s.loadReleases);
  const runs = useHelm((s) => s.runs);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const list = slice?.list ?? null;
  const error = slice?.error ?? null;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (list?.releases ?? [])
      .filter(
        (r) =>
          needle === "" ||
          r.name.toLowerCase().includes(needle) ||
          r.namespace.toLowerCase().includes(needle) ||
          r.chart.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          a.namespace.localeCompare(b.namespace) ||
          a.name.localeCompare(b.name),
      );
  }, [list, query]);

  const filterOptions = useMemo(
    () => [
      ...new Set([
        ...clusterNamespaces,
        ...(list?.releases ?? []).map((r) => r.namespace),
      ]),
    ],
    [clusterNamespaces, list],
  );

  const opened = parsePair(params.get("release"));
  const setRelease = (value: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value === null) next.delete("release");
      else next.set("release", value);
      return next;
    });

  const columns = useMemo<TableColumn<HelmRelease>[]>(() => {
    const menu = (r: HelmRelease, run: HelmRun | undefined) => {
      const actions = releaseActions(r, run, r.revision);
      const items = [
        actions.upgrade && {
          id: "upgrade",
          label: "Upgrade",
          icon: <CircleArrowUp size={14} aria-hidden="true" />,
          onSelect: () => {
            void navigate(upgradePath(clusterId, r.namespace, r.name));
          },
        },
        actions.rollback && {
          id: "rollback",
          label: "Roll back",
          icon: <History size={14} aria-hidden="true" />,
          onSelect: () => setDialog({ kind: "rollback", release: r }),
        },
        actions.uninstall && {
          id: "uninstall",
          label: "Uninstall",
          icon: <Trash2 size={14} aria-hidden="true" />,
          danger: true,
          onSelect: () => setDialog({ kind: "uninstall", release: r }),
        },
      ].filter((item) => item !== false);
      if (items.length === 0) return null;
      return (
        <Menu
          trigger={
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Actions for ${r.name}`}
              title="Actions"
              data-testid={`helm-release-menu-${r.namespace}-${r.name}`}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </Button>
          }
          items={items}
        />
      );
    };
    return [
      {
        id: "name",
        header: "Name",
        width: "minmax(140px, 1.5fr)",
        sortValue: (r) => r.name,
        render: (r) => r.name,
      },
      {
        id: "namespace",
        header: "Namespace",
        width: "minmax(120px, 1fr)",
        sortValue: (r) => r.namespace,
        render: (r) => r.namespace,
      },
      {
        id: "chart",
        header: "Chart",
        width: "minmax(140px, 1fr)",
        sortValue: (r) => r.chart,
        render: (r) => r.chart,
      },
      {
        id: "app",
        header: "App version",
        width: 112,
        render: (r) => r.appVersion ?? "—",
      },
      {
        id: "revision",
        header: "Revision",
        width: 88,
        sortValue: (r) => r.revision,
        render: (r) => String(r.revision),
      },
      {
        id: "status",
        header: "Status",
        width: 140,
        sortValue: (r) => r.status,
        render: (r) => (
          <span data-testid={`helm-release-status-${r.namespace}-${r.name}`}>
            <Badge tone={statusTone(r.status)}>{r.status}</Badge>
          </span>
        ),
      },
      {
        id: "updated",
        header: "Updated",
        width: 112,
        sortValue: (r) => r.updated ?? "",
        render: (r) => ago(r.updated, now),
      },
      {
        id: "actions",
        header: "Actions",
        width: 72,
        render: (r) => menu(r, runs[runKey(clusterId, r.namespace, r.name)]),
      },
    ];
  }, [clusterId, navigate, now, runs]);

  let body: ReactNode;
  if (error && isToolMissing(error)) {
    body = (
      <HelmMissing
        message={error.message}
        onReady={() => {
          void loadReleases(clusterId);
        }}
      />
    );
  } else if (error) {
    body = (
      <div data-testid="helm-releases-error">
        <ErrorNotice
          title="Could not list Helm releases"
          message={error.message}
          details={error.details}
          onRetry={() => {
            void loadReleases(clusterId);
          }}
        />
      </div>
    );
  } else if (list === null) {
    body = <Spinner label="Loading releases" />;
  } else if (list.releases.length === 0) {
    body = (
      <div data-testid="helm-releases-empty">
        <EmptyState
          title="No Helm releases in the namespaces you picked."
          body="Install one from Charts."
          action={
            <Button
              size="sm"
              onClick={() => {
                void navigate(chartsPath(clusterId));
              }}
              data-testid="helm-releases-browse"
            >
              Browse charts
            </Button>
          }
        />
      </div>
    );
  } else {
    body = (
      <VirtualTable
        rows={rows}
        columns={columns}
        rowKey={releaseKey}
        rowTestId={(r) => `helm-release-${r.namespace}-${r.name}`}
        rowLabel={(r) => `${r.name} in ${r.namespace}`}
        onRowClick={(r) => setRelease(pairParam(r.namespace, r.name))}
        activeKey={opened ? `${opened.first}/${opened.second}` : undefined}
        testId="helm-releases-table"
      />
    );
  }

  const partial = [
    list?.partial
      ? "You may not list releases in every namespace, so only the namespaces you may read are shown."
      : null,
    list && list.failedNamespaces.length > 0
      ? `Could not list releases in ${list.failedNamespaces.join(", ")}.`
      : null,
  ].filter((text) => text !== null);

  return (
    <div className={styles.screen} data-testid="helm-releases-screen">
      <div className={styles.toolbar}>
        <h2 className={styles.title} data-testid="helm-releases-title">
          Releases
        </h2>
        {list ? (
          <span data-testid="helm-releases-count">
            <Badge tone="neutral">{rows.length}</Badge>
          </span>
        ) : null}
        <Input
          aria-label="Search releases by name, namespace or chart"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="helm-releases-search"
        />
        <NamespaceFilter
          namespaces={filterOptions}
          selected={selected}
          onChange={setSelected}
        />
        <div className={styles.grow} />
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            void navigate(chartsPath(clusterId));
          }}
          data-testid="helm-releases-install"
        >
          <PackagePlus size={14} aria-hidden="true" />
          Install a chart
        </Button>
      </div>
      {partial.length > 0 && !error ? (
        <Notice tone="warn" testId="helm-releases-partial">
          {partial.join(" ")}
        </Notice>
      ) : null}
      <div className={styles.body}>
        <div className={styles.main}>{body}</div>
        {opened && !error ? (
          <HelmReleaseDrawer
            key={`${opened.first}/${opened.second}`}
            clusterId={clusterId}
            namespace={opened.first}
            name={opened.second}
            listed={list?.releases.find(
              (r) => r.namespace === opened.first && r.name === opened.second,
            )}
            listLoaded={list !== null}
            onClose={() => setRelease(null)}
          />
        ) : null}
      </div>
      {dialog?.kind === "rollback" ? (
        <RollbackDialog
          clusterId={clusterId}
          namespace={dialog.release.namespace}
          name={dialog.release.name}
          current={dialog.release.revision}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "uninstall" ? (
        <UninstallDialog
          clusterId={clusterId}
          namespace={dialog.release.namespace}
          name={dialog.release.name}
          status={dialog.release.status}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** The route inside a connected cluster's layout. */
export function HelmReleasesRoute() {
  const { clusterId } = useClusterContext();
  return <HelmReleasesScreen key={clusterId} clusterId={clusterId} />;
}
