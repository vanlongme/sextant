import {
  ArrowLeft,
  ArrowRight,
  Plus,
  Power,
  Search,
  SquareTerminal,
} from "lucide-react";
import { Badge, Button, IconButton } from "../design";
import { useConnect } from "../stores/clusters";
import { useShell } from "../stores/shell";
import styles from "./AppHeader.module.css";
import { clusterStatus } from "./clusterStatus";
import { runCommand, useCommandContext } from "./commands";
import type { CurrentCluster } from "./currentCluster";
import { IS_MAC, shortKeys } from "./shortcuts";

function title(pathname: string, cluster: CurrentCluster | null): string {
  if (cluster !== null) return cluster.name;
  if (pathname === "/catalog") return "Catalog";
  if (pathname === "/preferences") return "Preferences";
  return "";
}

/** Terminal and Disconnect on a connected cluster route (spec C §5, item 7). */
function ConnectedActions({ id }: { id: string }) {
  const ctx = useCommandContext();
  const { disconnect, busy } = useConnect(id);
  return (
    <>
      <Button
        data-testid="header-terminal"
        onClick={() => runCommand("terminal", ctx)}
      >
        <SquareTerminal size={14} aria-hidden="true" />
        Terminal
      </Button>
      <Button
        data-testid="cluster-disconnect"
        disabled={busy}
        onClick={() => void disconnect()}
      >
        <Power size={14} aria-hidden="true" />
        Disconnect
      </Button>
    </>
  );
}

/** The bar at the top of the content column on every route (spec C §5). */
export function AppHeader() {
  const ctx = useCommandContext();
  const { cluster, pathname } = ctx;
  const status = cluster === null ? null : clusterStatus(cluster.state);
  const info =
    cluster?.state.status === "connected" ? cluster.state.info : null;
  const paletteKeys = shortKeys("palette", IS_MAC);

  return (
    <header className={styles.header} data-testid="app-header">
      <div className={styles.history}>
        <IconButton
          label={`Back (${shortKeys("back", IS_MAC)})`}
          icon={<ArrowLeft size={16} aria-hidden="true" />}
          onClick={() => ctx.navigate(-1)}
          data-testid="header-back"
        />
        <IconButton
          label={`Forward (${shortKeys("forward", IS_MAC)})`}
          icon={<ArrowRight size={16} aria-hidden="true" />}
          onClick={() => ctx.navigate(1)}
          data-testid="header-forward"
        />
      </div>
      <h1 className={styles.title} data-testid="header-title">
        {title(pathname, cluster)}
      </h1>
      {status !== null ? (
        <span data-testid="connection-status">
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
      ) : null}
      {info !== null ? (
        <span className={styles.distribution} data-testid="header-distribution">
          {`${info.distribution || "Kubernetes"} · ${info.version}`}
        </span>
      ) : null}
      <div className={styles.spacer} />
      <button
        type="button"
        className={styles.palette}
        data-testid="palette-open"
        aria-label={`Command palette (${paletteKeys})`}
        aria-keyshortcuts="Control+Shift+P Meta+Shift+P"
        onClick={() => useShell.getState().open("palette")}
      >
        <Search size={14} aria-hidden="true" />
        <span className={styles.paletteText}>Search or run a command</span>
        <kbd className={styles.chip}>{paletteKeys}</kbd>
      </button>
      {pathname === "/catalog" ? (
        <Button
          variant="primary"
          data-testid="catalog-add"
          onClick={() => useShell.getState().openAddCluster()}
        >
          <Plus size={14} aria-hidden="true" />
          Add cluster
        </Button>
      ) : null}
      {cluster !== null && info !== null ? (
        <ConnectedActions key={cluster.id} id={cluster.id} />
      ) : null}
    </header>
  );
}
