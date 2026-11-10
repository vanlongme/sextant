import { Ellipsis } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { clusterStatus } from "../../app/clusterStatus";
import {
  Badge,
  Button,
  type Column,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorNotice,
  Input,
  Menu,
  Spinner,
  StatusDot,
  toast,
} from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import { useCatalog } from "../../stores/catalog";
import { useShell } from "../../stores/shell";
import { AddClusterDialog } from "./AddClusterDialog";
import styles from "./CatalogScreen.module.css";

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

function matches(cluster: ClusterEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return [
    cluster.name,
    cluster.contextName,
    basename(cluster.source.path),
  ].some((text) => text.toLocaleLowerCase().includes(needle));
}

function statusDetail(cluster: ClusterEntry): string | null {
  if (cluster.problem) return cluster.problem;
  return cluster.state.status === "failed" ? cluster.state.message : null;
}

function ConnectButton({ cluster }: { cluster: ClusterEntry }) {
  const [busy, setBusy] = useState(false);
  const status = cluster.state.status;
  const live = status === "connected" || status === "connecting";

  async function run(): Promise<void> {
    setBusy(true);
    try {
      if (live) await api.clusterDisconnect(cluster.id);
      else await api.clusterConnect(cluster.id);
    } catch (error) {
      const action = live ? "disconnect from" : "connect to";
      toast.error(`Could not ${action} ${cluster.name}`, failureMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size="sm"
      // A connect can run for minutes, and must stay cancellable meanwhile.
      loading={busy && status !== "connecting"}
      disabled={!live && cluster.problem !== null}
      onClick={() => void run()}
    >
      {live ? "Disconnect" : "Connect"}
    </Button>
  );
}

type MenuItem = { id: string; label: string; onSelect(): void };

function RowActions(props: {
  cluster: ClusterEntry;
  onRemove(cluster: ClusterEntry): void;
}) {
  const { cluster, onRemove } = props;
  const pinned = useCatalog((s) => s.hotbar.includes(cluster.id));
  const pin = useCatalog((s) => s.pin);
  const unpin = useCatalog((s) => s.unpin);

  const items: MenuItem[] = [
    pinned
      ? {
          id: "unpin",
          label: "Unpin from hotbar",
          onSelect: () => void unpin(cluster.id),
        }
      : {
          id: "pin",
          label: "Pin to hotbar",
          onSelect: () => void pin(cluster.id),
        },
  ];
  if (cluster.source.kind === "pasted") {
    items.push({
      id: "remove",
      label: "Remove",
      onSelect: () => onRemove(cluster),
    });
  }

  return (
    // The row opens the cluster on click, and these controls must not.
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops bubbling.
    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops bubbling.
    <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
      <ConnectButton cluster={cluster} />
      <Menu
        items={items}
        trigger={
          // No Tooltip here: closing the menu returns focus to this button,
          // and a tooltip opened by that focus would cover the row above.
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Actions for ${cluster.name}`}
            title="Actions"
            data-testid={`catalog-menu-${cluster.contextName}`}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </Button>
        }
      />
    </div>
  );
}

export function CatalogScreen() {
  const clusters = useCatalog((s) => s.clusters);
  const warnings = useCatalog((s) => s.warnings);
  const loading = useCatalog((s) => s.loading);
  const error = useCatalog((s) => s.error);
  const reload = useCatalog((s) => s.reload);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const addClusterOpen = useShell((s) => s.addClusterOpen);
  const closeAddCluster = useShell((s) => s.closeAddCluster);
  const [removing, setRemoving] = useState<ClusterEntry | null>(null);

  const rows = useMemo(
    () => clusters.filter((cluster) => matches(cluster, query)),
    [clusters, query],
  );

  const columns = useMemo<Column<ClusterEntry>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        sortable: true,
        sortValue: (c) => c.name,
        render: (c) => (
          <Link
            to={`/cluster/${encodeURIComponent(c.id)}`}
            className={styles.name}
            title={c.name}
            onClick={(e) => e.stopPropagation()}
          >
            {c.name}
          </Link>
        ),
      },
      {
        id: "source",
        header: "Source",
        width: "20%",
        sortable: true,
        sortValue: (c) => basename(c.source.path),
        render: (c) => (
          <span className={styles.source}>
            <span className={styles.truncated} title={c.source.path}>
              {basename(c.source.path)}
            </span>
            {c.source.kind === "pasted" ? (
              <Badge tone="info">Pasted</Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "distribution",
        header: "Distribution",
        width: "120px",
        render: (c) =>
          c.state.status === "connected" ? c.state.info.distribution : null,
      },
      {
        id: "status",
        header: "Status",
        width: "28%",
        render: (c) => {
          const status = clusterStatus(c.state);
          const detail = statusDetail(c);
          return (
            <span className={styles.status}>
              <StatusDot tone={status.tone} label={status.label} />
              <span>{status.label}</span>
              {detail ? (
                <span className={styles.detail} title={detail}>
                  {detail}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        width: "150px",
        render: (c) => <RowActions cluster={c} onRemove={setRemoving} />,
      },
    ],
    [],
  );

  async function remove(cluster: ClusterEntry): Promise<void> {
    setRemoving(null);
    try {
      await api.catalogRemovePasted(cluster.id);
    } catch (failure) {
      toast.error(`Could not remove ${cluster.name}`, failureMessage(failure));
    }
  }

  let body: React.ReactNode;
  if (loading) {
    body = <Spinner />;
  } else if (error) {
    body = (
      <ErrorNotice
        title="The catalog could not be loaded"
        message={error}
        onRetry={() => void reload()}
      />
    );
  } else if (clusters.length === 0) {
    body = (
      <div data-testid="catalog-table">
        <EmptyState
          title="No clusters yet"
          body={
            <>
              SkoposIDE lists every context in the files in <code>~/.kube</code>{" "}
              and in <code>$KUBECONFIG</code>. Add a kubeconfig file there, or
              paste one in.
            </>
          }
        />
      </div>
    );
  } else {
    body = (
      // The card wraps the table only: the no-match EmptyState is a card of
      // its own, and spec §6.1 allows no raised card inside a raised card.
      <div className={rows.length > 0 ? styles.table : undefined}>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(c) => c.id}
          rowTestId={(c) => `catalog-row-${c.contextName}`}
          onRowClick={(c) => navigate(`/cluster/${encodeURIComponent(c.id)}`)}
          empty={<EmptyState title={`No clusters match "${query}"`} />}
          testId="catalog-table"
        />
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.toolbar}>
        <Input
          aria-label="Search clusters"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="catalog-search"
        />
      </header>
      {warnings.length > 0 ? (
        <ul className={styles.warnings} data-testid="catalog-warnings">
          {warnings.map((w) => (
            <li key={w.path}>
              <strong>{w.path}</strong>: {w.message}
            </li>
          ))}
        </ul>
      ) : null}
      {body}
      <AddClusterDialog open={addClusterOpen} onClose={closeAddCluster} />
      <ConfirmDialog
        open={removing !== null}
        title="Remove pasted cluster"
        body={
          <>
            Remove <strong>{removing?.name}</strong> from the catalog? The
            pasted kubeconfig is deleted.
          </>
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
