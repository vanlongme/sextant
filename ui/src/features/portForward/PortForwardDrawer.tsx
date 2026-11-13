import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { ErrorNotice, IconButton, Tabs } from "../../design";
import type { PortForward } from "../../ipc/generated/PortForward";
import { resourcePath } from "../../kinds/nav";
import { DRAWER_PANE, usePaneSize } from "../../stores/paneSize";
import { CopyRow } from "../details/CopyRow";
import styles from "../details/DetailDrawer.module.css";
import { DrawerResize } from "../details/DrawerResize";
import { ForwardStatus } from "./ForwardStatus";
import { forwardActions } from "./forwardActions";
import { localAddress, portText, STATE_LOOK, targetText } from "./forwardText";
import own from "./PortForward.module.css";

const TABS = [{ value: "overview", label: "Overview" }];

const BOTH =
  "SkoposIDE binds 127.0.0.1 only, so other machines cannot use the forward. The definition stays across restarts; it does not start on its own.";

/** One forward, with the frame and look of the object drawer (spec §6.5). */
export function PortForwardDrawer(props: {
  clusterId: string;
  forward: PortForward;
  onClose(): void;
}) {
  const { clusterId, forward, onClose } = props;
  const { kind, namespace, name } = forward.target;
  const drawerRef = useRef<HTMLElement>(null);
  const [drawerWidth, setDrawerWidth] = usePaneSize(DRAWER_PANE);

  // As in the object drawer: focus comes in on open and goes back where it was.
  useEffect(() => {
    const before = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const plural = kind === "service" ? "services" : "pods";
  const objectLink = `${resourcePath(clusterId, "", plural)}?object=${encodeURIComponent(`${namespace}/${name}`)}`;
  const how =
    kind === "service"
      ? `Each new connection goes to a Ready Pod of ${name}, so the forward survives Pod replacement.`
      : `Each connection goes to Pod ${name}. A Pod forward ends with its Pod; forward the Service to follow replacements.`;

  return (
    <aside
      ref={drawerRef}
      tabIndex={-1}
      className={styles.drawer}
      aria-label="Port forward details"
      data-testid="pf-drawer"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // A tooltip or menu in a portal still bubbles its keys here; that Escape is its own.
        if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target))
          return;
        e.stopPropagation();
        onClose();
      }}
      style={{ flexBasis: drawerWidth }}
    >
      <DrawerResize width={drawerWidth} onChange={setDrawerWidth} />
      <header className={styles.header}>
        <h3
          className={styles.title}
          data-testid="pf-drawer-title"
          title={targetText(forward)}
        >
          {targetText(forward)}
        </h3>
        <span className={styles.kind}>Port forward in {namespace}</span>
        <ForwardStatus forward={forward} testId="pf-drawer-status" />
        <div className={styles.grow} />
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a header toolbar does not want. */}
        <div role="group" aria-label="Actions" className={own.actions}>
          {forwardActions(forward).map((action) => {
            const Icon = action.icon;
            return (
              <IconButton
                key={action.id}
                label={action.label}
                icon={<Icon size={14} aria-hidden="true" />}
                onClick={() => {
                  void action.run();
                }}
                data-testid={`pf-drawer-${action.id}`}
              />
            );
          })}
        </div>
        <span className={styles.divider} aria-hidden="true" />
        <IconButton
          label="Close details"
          icon={<X size={14} aria-hidden="true" />}
          onClick={onClose}
          data-testid="pf-drawer-close"
        />
      </header>
      <Tabs value="overview" onChange={() => {}} tabs={TABS} />
      <div className={styles.content}>
        <section className={styles.section} data-testid="pf-drawer-forward">
          <h4 className={styles.heading}>Port forward</h4>
          <dl className={styles.facts}>
            <CopyRow label="Target">
              <Link
                className={styles.link}
                to={objectLink}
                data-testid="pf-drawer-target"
              >
                {targetText(forward)}
              </Link>
            </CopyRow>
            <CopyRow label="Namespace">{namespace}</CopyRow>
            <CopyRow label="Target port">{portText(forward)}</CopyRow>
            <CopyRow label="Local address">{localAddress(forward)}</CopyRow>
            <CopyRow label="Status">{STATE_LOOK[forward.state].label}</CopyRow>
            <CopyRow label="Connections">
              {String(forward.activeConnections)}
            </CopyRow>
          </dl>
        </section>
        {forward.message !== null && forward.state === "failed" ? (
          <div className={styles.section} data-testid="pf-drawer-message">
            <ErrorNotice
              title="Port forward failed"
              message={forward.message}
            />
          </div>
        ) : null}
        {forward.message !== null && forward.state !== "failed" ? (
          <section className={styles.section} data-testid="pf-drawer-note">
            <h4 className={styles.heading}>Last connection</h4>
            <p className={styles.message}>{forward.message}</p>
          </section>
        ) : null}
        <section className={styles.section} data-testid="pf-drawer-how">
          <h4 className={styles.heading}>How it works</h4>
          <p className={own.paragraph}>{how}</p>
          <p className={own.paragraph}>{BOTH}</p>
        </section>
      </div>
    </aside>
  );
}
