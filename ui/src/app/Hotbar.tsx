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
import { LayoutGrid, Pin, Settings, TriangleAlert } from "lucide-react";
import { NavLink, useMatch, useNavigate } from "react-router";
import { ContextMenu, Spinner, StatusDot, Tooltip } from "../design";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import { useCatalog } from "../stores/catalog";
import { clusterStatus } from "./clusterStatus";
import { clusterColor, clusterInitials } from "./clusterVisual";
import styles from "./Hotbar.module.css";

function HotbarItem({ cluster }: { cluster: ClusterEntry }) {
  const navigate = useNavigate();
  const unpin = useCatalog((s) => s.unpin);
  const active = useMatch(`/cluster/${encodeURIComponent(cluster.id)}`);
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
              onClick={() =>
                navigate(`/cluster/${encodeURIComponent(cluster.id)}`)
              }
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
      <RailLink
        to="/preferences"
        label="Preferences"
        testId="nav-preferences"
        icon={<Settings size={18} aria-hidden="true" />}
      />
    </nav>
  );
}
