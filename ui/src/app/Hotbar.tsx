import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CircleHelp,
  Columns2,
  Command,
  Info,
  Keyboard,
  LayoutGrid,
  Pin,
  Settings,
  TriangleAlert,
} from "lucide-react";
import { NavLink, useMatch, useNavigate } from "react-router";
import {
  ContextMenu,
  IconButton,
  Menu,
  Spinner,
  StatusDot,
  Tooltip,
} from "../design";
import { focusedClusterId } from "../features/workspace/layout";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import { useCatalog } from "../stores/catalog";
import { useShell } from "../stores/shell";
import { openInWorkspace, useWorkspace } from "../stores/workspace";
import { clusterStatus } from "./clusterStatus";
import { clusterColor, clusterInitials } from "./clusterVisual";
import styles from "./Hotbar.module.css";

function HotbarItem({ cluster }: { cluster: ClusterEntry }) {
  const navigate = useNavigate();
  const unpin = useCatalog((s) => s.unpin);
  const onCluster = useMatch(`/cluster/${encodeURIComponent(cluster.id)}`);
  const onWorkspace = useMatch("/workspace") !== null;
  const focused = useWorkspace(
    (s) => focusedClusterId(s.layout) === cluster.id,
  );
  // On the Workspace, the focused pane's cluster is the active tile (spec E §15.1).
  const active = onWorkspace ? focused : onCluster !== null;
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: cluster.id });
  const status = clusterStatus(cluster.state);

  return (
    <li
      ref={setNodeRef}
      className={styles.slot}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <ContextMenu
        items={[
          {
            id: "unpin",
            label: "Unpin",
            onSelect: () => void unpin(cluster.id),
          },
        ]}
      >
        <div>
          <Tooltip
            content={
              <span className={styles.tipName} title={cluster.name}>
                {cluster.name}
              </span>
            }
          >
            <button
              {...attributes}
              {...listeners}
              type="button"
              className={styles.item}
              style={{ backgroundColor: clusterColor(cluster.id) }}
              aria-label={cluster.name}
              aria-current={active ? "page" : undefined}
              data-testid={`hotbar-item-${cluster.id}`}
              onClick={(event) => {
                // Spec E §15.1: on the Workspace a click opens the cluster in the
                // focused pane; Shift-click anywhere opens it to the side there.
                if (onWorkspace || event.shiftKey) {
                  void openInWorkspace(cluster.id, event.shiftKey);
                  if (!onWorkspace) navigate("/workspace");
                  return;
                }
                navigate(`/cluster/${encodeURIComponent(cluster.id)}`);
              }}
            >
              {cluster.icon ? (
                <img src={cluster.icon} alt="" className={styles.icon} />
              ) : (
                <span aria-hidden="true">{clusterInitials(cluster.name)}</span>
              )}
              <span className={styles.status}>
                <StatusDot tone={status.tone} label={status.label} />
              </span>
            </button>
          </Tooltip>
        </div>
      </ContextMenu>
    </li>
  );
}

function RailLink(props: {
  to: string;
  label: string;
  testId: string;
  icon: React.ReactNode;
}) {
  return (
    <Tooltip content={props.label}>
      <NavLink
        to={props.to}
        aria-label={props.label}
        data-testid={props.testId}
        className={styles.link}
      >
        {props.icon}
      </NavLink>
    </Tooltip>
  );
}

function RailNotice(props: { label: string; icon: React.ReactNode }) {
  return (
    <Tooltip content={props.label}>
      <span role="img" aria-label={props.label} className={styles.notice}>
        {props.icon}
      </span>
    </Tooltip>
  );
}

/** Spec C §9.1: the shell dialogs from the rail, without key chips. */
function HelpMenu() {
  const open = useShell((s) => s.open);
  return (
    <Menu
      trigger={
        <IconButton
          label="Help"
          tooltip={false}
          icon={<CircleHelp size={18} aria-hidden="true" />}
          className={styles.help}
          data-testid="hotbar-help"
        />
      }
      items={[
        {
          id: "palette",
          label: "Command palette",
          icon: <Command size={14} aria-hidden="true" />,
          testId: "help-palette",
          onSelect: () => open("palette"),
        },
        {
          id: "shortcuts",
          label: "Keyboard shortcuts",
          icon: <Keyboard size={14} aria-hidden="true" />,
          testId: "help-shortcuts",
          onSelect: () => open("shortcuts"),
        },
        {
          id: "about",
          label: "About SkoposIDE",
          icon: <Info size={14} aria-hidden="true" />,
          testId: "help-about",
          onSelect: () => open("about"),
        },
      ]}
    />
  );
}

export function Hotbar() {
  const clusters = useCatalog((s) => s.clusters);
  const hotbar = useCatalog((s) => s.hotbar);
  const loading = useCatalog((s) => s.loading);
  const error = useCatalog((s) => s.error);
  const reorderHotbar = useCatalog((s) => s.reorderHotbar);

  const pinned = hotbar.flatMap((id) => {
    const cluster = clusters.find((c) => c.id === id);
    return cluster ? [cluster] : [];
  });

  const sensors = useSensors(
    // A small threshold, so a plain click still opens the cluster.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter stays a click on the item.
      keyboardCodes: {
        start: ["Space"],
        cancel: ["Escape"],
        end: ["Space"],
      },
    }),
  );

  function onDragEnd({ active, over }: DragEndEvent): void {
    if (!over || active.id === over.id) return;
    const ids = pinned.map((c) => c.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) void reorderHotbar(arrayMove(ids, from, to));
  }

  return (
    <nav className={styles.rail} aria-label="Hotbar" data-testid="hotbar">
      <RailLink
        to="/catalog"
        label="Catalog"
        testId="nav-catalog"
        icon={<LayoutGrid size={18} aria-hidden="true" />}
      />
      <RailLink
        to="/workspace"
        label="Workspace"
        testId="nav-workspace"
        icon={<Columns2 size={18} aria-hidden="true" />}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={pinned.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className={styles.list}>
            {pinned.map((cluster) => (
              <HotbarItem key={cluster.id} cluster={cluster} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {loading ? <Spinner /> : null}
      {!loading && error ? (
        <RailNotice
          label="The clusters could not be loaded"
          icon={<TriangleAlert size={18} aria-hidden="true" />}
        />
      ) : null}
      {!loading && !error && pinned.length === 0 ? (
        <RailNotice
          label="Pin clusters from the catalog to keep them here"
          icon={<Pin size={18} aria-hidden="true" />}
        />
      ) : null}
      <div className={styles.spacer} />
      <HelpMenu />
      <RailLink
        to="/preferences"
        label="Preferences"
        testId="nav-preferences"
        icon={<Settings size={18} aria-hidden="true" />}
      />
    </nav>
  );
}
