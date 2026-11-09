import {
  ChevronDown,
  ChevronUp,
  FileCode,
  FilePlus,
  type LucideIcon,
  Plus,
  ScrollText,
  X,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { Button, ConfirmDialog, IconButton } from "../../design";
import {
  type DockTab,
  newCreateTab,
  tabsForCluster,
  useDock,
} from "../../stores/dock";
import { CreateResourceTab } from "../editor/CreateResourceTab";
import { EditResourceTab } from "../editor/EditResourceTab";
import styles from "./Dock.module.css";

const KEYBOARD_RESIZE_STEP = 24;

const TAB_ICONS: Record<DockTab["kind"], LucideIcon> = {
  edit: FileCode,
  create: FilePlus,
  logs: ScrollText,
};

function TabBody({ tab }: { tab: DockTab }) {
  switch (tab.kind) {
    case "edit":
      return <EditResourceTab tab={tab} />;
    case "create":
      return <CreateResourceTab tab={tab} />;
    case "logs":
      // The Logs view arrives with the next part of this plan.
      return null;
  }
}

/** The drag handle on the dock's top edge. Up makes the dock taller. */
function ResizeHandle() {
  const height = useDock((s) => s.height);
  const setHeight = useDock((s) => s.setHeight);
  const drag = useRef<{ fromY: number; fromHeight: number } | null>(null);

  function start(event: PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { fromY: event.clientY, fromHeight: height };
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    setHeight(drag.current.fromHeight + drag.current.fromY - event.clientY);
  }

  function stop(): void {
    drag.current = null;
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowUp") setHeight(height + KEYBOARD_RESIZE_STEP);
    if (event.key === "ArrowDown") setHeight(height - KEYBOARD_RESIZE_STEP);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an hr cannot be dragged or focused.
    <div
      className={styles.resize}
      role="separator"
      aria-label="Resize dock"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(height)}
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={key}
      data-testid="dock-resize"
    />
  );
}

/** The panel under a cluster's content that holds its editors. */
export function Dock(props: { clusterId: string }) {
  const { clusterId } = props;
  const allTabs = useDock((s) => s.tabs);
  const activeId = useDock((s) => s.activeId);
  const height = useDock((s) => s.height);
  const minimized = useDock((s) => s.minimized);
  const [closing, setClosing] = useState<DockTab | null>(null);

  const tabs = tabsForCluster(allTabs, clusterId);
  // The active tab may be another cluster's, which is not shown here.
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  const expanded = active !== null && !minimized;

  function select(tab: DockTab): void {
    const dock = useDock.getState();
    dock.activate(tab.id);
    dock.setMinimized(false);
  }

  function requestClose(tab: DockTab): void {
    if (tab.dirty) setClosing(tab);
    else useDock.getState().close(tab.id);
  }

  return (
    <section
      className={styles.dock}
      style={expanded ? { height } : undefined}
      aria-label="Dock"
      data-testid="dock"
    >
      {expanded ? <ResizeHandle /> : null}
      <div className={styles.bar}>
        <div className={styles.tabs} role="tablist" aria-label="Open editors">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.kind];
            return (
              <div
                key={tab.id}
                className={styles.tab}
                data-active={expanded && tab.id === active?.id}
                role="presentation"
              >
                <button
                  type="button"
                  role="tab"
                  id={`dock-tab-${tab.id}`}
                  className={styles.tabLabel}
                  aria-selected={tab.id === active?.id}
                  aria-controls={`dock-panel-${tab.id}`}
                  title={tab.title}
                  onClick={() => select(tab)}
                  data-testid={`dock-tab-${tab.id}`}
                  data-dirty={tab.dirty}
                >
                  <Icon
                    size={14}
                    aria-hidden="true"
                    className={styles.tabIcon}
                  />
                  {tab.dirty ? (
                    <span className={styles.dirty} title="Unsaved changes">
                      ●
                    </span>
                  ) : null}
                  {tab.title}
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  aria-label={`Close ${tab.title}`}
                  title="Close"
                  onClick={() => requestClose(tab)}
                  data-testid={`dock-close-${tab.id}`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useDock.getState().open(newCreateTab(clusterId))}
          data-testid="create-resource"
        >
          <Plus size={14} aria-hidden="true" />
          Create
        </Button>
        {tabs.length > 0 ? (
          <IconButton
            label={minimized ? "Restore dock" : "Minimize dock"}
            icon={
              minimized ? (
                <ChevronUp size={16} aria-hidden="true" />
              ) : (
                <ChevronDown size={16} aria-hidden="true" />
              )
            }
            aria-expanded={!minimized}
            onClick={() => useDock.getState().setMinimized(!minimized)}
            data-testid="dock-minimize"
          />
        ) : null}
      </div>
      {tabs.map((tab) => (
        // Hidden, not unmounted: another tab or minimizing must keep the editor,
        // and a Logs tab keeps streaming.
        <div
          key={tab.id}
          id={`dock-panel-${tab.id}`}
          className={styles.panel}
          role="tabpanel"
          aria-labelledby={`dock-tab-${tab.id}`}
          hidden={!expanded || tab.id !== active?.id}
          data-testid={`dock-panel-${tab.id}`}
        >
          <TabBody tab={tab} />
        </div>
      ))}
      {closing ? (
        <ConfirmDialog
          open
          title="Discard unsaved changes?"
          body={`${closing.title} has changes that were not saved.`}
          confirmLabel="Discard"
          danger
          onConfirm={() => {
            useDock.getState().close(closing.id);
            setClosing(null);
          }}
          onCancel={() => setClosing(null)}
        />
      ) : null}
    </section>
  );
}
