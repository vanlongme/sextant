import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronUp,
  FileCode,
  FilePlus,
  type LucideIcon,
  Plug,
  Plus,
  ScrollText,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button, ConfirmDialog, IconButton } from "../../design";
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  type DockTab,
  dockMaxHeight,
  newCreateTab,
  tabsForCluster,
  useDock,
} from "../../stores/dock";
import { CreateResourceTab } from "../editor/CreateResourceTab";
import { EditResourceTab } from "../editor/EditResourceTab";
import { LogsTab } from "../logs/LogsTab";
import styles from "./Dock.module.css";

const KEYBOARD_RESIZE_STEP = 24;
/** A press that moves less than this is a click, so it still selects the tab. */
const DRAG_DISTANCE = 4;

const TAB_ICONS: Record<DockTab["kind"], LucideIcon> = {
  edit: FileCode,
  create: FilePlus,
  logs: ScrollText,
  terminal: SquareTerminal,
  shell: Terminal,
  attach: Plug,
  nodeShell: Terminal,
};

function TabBody({ tab }: { tab: DockTab }) {
  switch (tab.kind) {
    case "edit":
      return <EditResourceTab tab={tab} />;
    case "create":
      return <CreateResourceTab tab={tab} />;
    case "logs":
      return <LogsTab tab={tab} />;
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
      aria-valuemin={DOCK_MIN_HEIGHT}
      aria-valuemax={Math.round(dockMaxHeight())}
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => setHeight(DOCK_DEFAULT_HEIGHT)}
      onKeyDown={key}
      data-testid="dock-resize"
    />
  );
}

/** One tab on the dock bar. It is sortable, and Ctrl+Shift+PageUp/PageDown move it. */
function DockTabItem(props: {
  tab: DockTab;
  /** Selected and shown. */
  active: boolean;
  selected: boolean;
  onSelect(): void;
  onClose(): void;
  onMove(delta: -1 | 1): void;
}) {
  const { tab } = props;
  const { listeners, setNodeRef, transform, transition } = useSortable({
    id: tab.id,
  });
  const Icon = TAB_ICONS[tab.kind];

  function key(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!event.ctrlKey || !event.shiftKey) return;
    if (event.key !== "PageUp" && event.key !== "PageDown") return;
    event.preventDefault();
    props.onMove(event.key === "PageUp" ? -1 : 1);
  }

  return (
    <div
      ref={setNodeRef}
      className={styles.tab}
      data-active={props.active}
      role="presentation"
      style={{
        // Along the bar only.
        transform: transform
          ? `translate3d(${Math.round(transform.x)}px, 0, 0)`
          : undefined,
        transition,
      }}
    >
      <button
        type="button"
        role="tab"
        id={`dock-tab-${tab.id}`}
        className={styles.tabLabel}
        aria-selected={props.selected}
        aria-controls={`dock-panel-${tab.id}`}
        title={tab.title}
        {...listeners}
        onClick={props.onSelect}
        onKeyDown={key}
        data-testid={`dock-tab-${tab.id}`}
        data-dirty={tab.dirty}
      >
        <Icon size={14} aria-hidden="true" className={styles.tabIcon} />
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
        onClick={props.onClose}
        data-testid={`dock-close-${tab.id}`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The panel under a cluster's content that holds its editors and logs. */
export function Dock(props: { clusterId: string }) {
  const { clusterId } = props;
  const restored = useDock((s) => s.restored);
  const allTabs = useDock((s) => s.tabs);
  const activeId = useDock((s) => s.activeId);
  const height = useDock((s) => s.height);
  const minimized = useDock((s) => s.minimized);
  const [closing, setClosing] = useState<DockTab | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_DISTANCE },
    }),
  );

  // The saved layout comes first, so its tabs do not appear after a moment.
  if (!restored) return null;

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

  function moveBy(tab: DockTab, delta: -1 | 1): void {
    const at = tabs.findIndex((t) => t.id === tab.id);
    // Reordering moves the button in the DOM, which drops the focus: give it back.
    flushSync(() => useDock.getState().move(tab.id, at + delta));
    document.getElementById(`dock-tab-${tab.id}`)?.focus();
  }

  function onDragEnd({ active: dragged, over }: DragEndEvent): void {
    if (!over || dragged.id === over.id) return;
    const to = tabs.findIndex((t) => t.id === String(over.id));
    if (to !== -1) useDock.getState().move(String(dragged.id), to);
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div
              className={styles.tabs}
              role="tablist"
              aria-label="Open editors"
            >
              {tabs.map((tab) => (
                <DockTabItem
                  key={tab.id}
                  tab={tab}
                  active={expanded && tab.id === active?.id}
                  selected={tab.id === active?.id}
                  onSelect={() => select(tab)}
                  onClose={() => requestClose(tab)}
                  onMove={(delta) => moveBy(tab, delta)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
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
