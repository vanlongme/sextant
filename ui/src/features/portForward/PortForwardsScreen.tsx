import { Ellipsis } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Menu,
  Spinner,
  type TableColumn,
  VirtualTable,
} from "../../design";
import type { PortForward } from "../../ipc/generated/PortForward";
import { resourcePath } from "../../kinds/nav";
import { forwardsOf, usePortForwards } from "../../stores/portForwards";
import { useClusterContext } from "../cluster/ClusterLayout";
import styles from "../resources/ResourceScreen.module.css";
import { ForwardStatus } from "./ForwardStatus";
import { forwardActions, removeForwards } from "./forwardActions";
import {
  kindLabel,
  localText,
  portText,
  STATE_LOOK,
  targetText,
} from "./forwardText";
import { PortForwardDrawer } from "./PortForwardDrawer";

/** The same action menu as the resource lists, with the items of spec §6.3. */
function RowMenu({ forward }: { forward: PortForward }) {
  return (
    <Menu
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Actions for ${targetText(forward)} port ${portText(forward)}`}
          title="Actions"
          data-testid={`pf-menu-${forward.id}`}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </Button>
      }
      items={forwardActions(forward).map((action) => {
        const Icon = action.icon;
        return {
          id: action.id,
          label: action.label,
          icon: <Icon size={14} aria-hidden="true" />,
          danger: action.danger,
          testId: `pf-${action.id}-${forward.id}`,
          onSelect: () => {
            void action.run();
          },
        };
      })}
    />
  );
}

const COLUMNS: TableColumn<PortForward>[] = [
  {
    id: "name",
    header: "Name",
    width: "minmax(160px, 2fr)",
    sortValue: (f) => f.target.name,
    render: (f) => f.target.name,
  },
  {
    id: "namespace",
    header: "Namespace",
    width: "minmax(120px, 1fr)",
    sortValue: (f) => f.target.namespace,
    render: (f) => f.target.namespace,
  },
  {
    id: "kind",
    header: "Kind",
    width: 96,
    sortValue: kindLabel,
    render: kindLabel,
  },
  { id: "port", header: "Port", width: 88, render: portText },
  {
    id: "local",
    header: "Local",
    width: 168,
    render: (f) => <span data-testid={`pf-local-${f.id}`}>{localText(f)}</span>,
  },
  {
    id: "status",
    header: "Status",
    width: 120,
    sortValue: (f) => STATE_LOOK[f.state].label,
    render: (f) => <ForwardStatus forward={f} testId={`pf-status-${f.id}`} />,
  },
  {
    id: "connections",
    header: "Connections",
    width: 112,
    sortValue: (f) => f.activeConnections,
    render: (f) => (
      <span data-testid={`pf-connections-${f.id}`}>{f.activeConnections}</span>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    width: 72,
    render: (f) => <RowMenu forward={f} />,
  },
];

/** The cluster's port forward definitions (spec §6). */
export function PortForwardsScreen({ clusterId }: { clusterId: string }) {
  const navigate = useNavigate();
  const all = usePortForwards((s) => s.forwards);
  const loaded = usePortForwards((s) => s.loaded);
  const error = usePortForwards((s) => s.error);
  const retry = usePortForwards((s) => s.retry);
  const rows = useMemo(() => forwardsOf(all, clusterId), [all, clusterId]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Derived from the list, so the drawer closes when its forward goes away.
  const opened =
    openId === null ? undefined : rows.find((f) => f.id === openId);

  // Only the rows on screen count, so a forward that went away is never sent.
  const shownSelected = rows.filter((f) => selected.has(f.id)).map((f) => f.id);

  async function removeSelected(): Promise<void> {
    setRemoving(true);
    const failed = await removeForwards(shownSelected);
    setRemoving(false);
    setSelected(new Set(failed));
  }

  let body: ReactNode;
  if (!loaded && error !== null) {
    body = (
      <div data-testid="pf-load-error">
        <ErrorNotice
          title="Could not load port forwards"
          message={error}
          onRetry={() => {
            void retry();
          }}
        />
      </div>
    );
  } else if (!loaded) {
    body = <Spinner label="Loading port forwards" />;
  } else if (rows.length === 0) {
    body = (
      <div data-testid="pf-empty">
        <EmptyState
          title="No port forwards for this cluster"
          body="Start one from a Pod or a Service: open it and pick Port forward."
          action={
            <Button
              size="sm"
              data-testid="pf-open-services"
              onClick={() => {
                void navigate(resourcePath(clusterId, "", "services"));
              }}
            >
              Open Services
            </Button>
          }
        />
      </div>
    );
  } else {
    body = (
      <VirtualTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(f) => f.id}
        rowTestId={(f) => `pf-row-${f.id}`}
        rowLabel={(f) => `${targetText(f)} port ${portText(f)}`}
        selectTestId={(f) => `pf-select-${f.id}`}
        selected={selected}
        onSelectedChange={setSelected}
        onRowClick={(f) => setOpenId(f.id)}
        activeKey={opened?.id}
        testId="pf-table"
      />
    );
  }

  return (
    <div className={styles.screen} data-testid="port-forwards-screen">
      <div className={styles.toolbar}>
        <h2 className={styles.title} data-testid="pf-title">
          Port Forwarding
        </h2>
        {loaded ? (
          <span data-testid="pf-count">
            <Badge tone="neutral">{rows.length}</Badge>
          </span>
        ) : null}
        <div className={styles.grow} />
        <Button
          size="sm"
          variant="danger"
          disabled={shownSelected.length === 0}
          loading={removing}
          onClick={() => {
            void removeSelected();
          }}
          data-testid="pf-bulk-remove"
        >
          Remove{shownSelected.length > 0 ? ` (${shownSelected.length})` : ""}
        </Button>
      </div>
      <div className={styles.body}>
        <div className={styles.main}>{body}</div>
        {opened ? (
          <PortForwardDrawer
            key={opened.id}
            clusterId={clusterId}
            forward={opened}
            onClose={() => setOpenId(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The route inside a connected cluster's layout. */
export function PortForwardsRoute() {
  const { clusterId } = useClusterContext();
  return <PortForwardsScreen key={clusterId} clusterId={clusterId} />;
}
