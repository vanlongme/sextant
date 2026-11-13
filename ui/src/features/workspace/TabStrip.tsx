import { Columns2, Pin, PinOff, X } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";
import { flushSync } from "react-dom";
import { clusterStatus } from "../../app/clusterStatus";
import { clusterColor, clusterInitials } from "../../app/clusterVisual";
import { IS_MAC, matchesShortcut, shortKeys } from "../../app/shortcuts";
import { ContextMenu, IconButton, StatusDot, Tooltip } from "../../design";
import type { ContextMenuItem } from "../../design/ContextMenu";
import { useWorkspace } from "../../stores/workspace";
import { tabLabel, useClusterName, useWorkspaceClusterState } from "./clusters";
import {
  activeTab,
  MAX_PANES,
  type TabActions,
  tabActions,
  type WorkspacePane,
  type WorkspaceTab,
} from "./layout";
import styles from "./TabStrip.module.css";

const FULL = "3 panes at most";

export function tabElementId(tabId: string): string {
  return `workspace-tab-${tabId}`;
}

function focusTab(tabId: string | null): void {
  if (tabId) document.getElementById(tabElementId(tabId))?.focus();
}

/** Shift+F10 and the context-menu key open the menu where the tab is. */
function openMenuAt(button: HTMLElement): void {
  const box = button.getBoundingClientRect();
  button.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.bottom,
    }),
  );
}

/** The items of a tab's context menu (spec E §15.3). */
function menuItems(
  pane: WorkspacePane,
  index: number,
  tab: WorkspaceTab,
  can: TabActions,
): ContextMenuItem[] {
  const { dispatch } = useWorkspace.getState();
  /** To the end of the pane `step` away from this one. */
  function moveBy(step: number): void {
    const target = useWorkspace.getState().layout.panes[index + step];
    if (!target) return;
    dispatch({
      type: "move",
      tabId: tab.id,
      paneId: target.id,
      index: target.tabs.length,
    });
  }
  return [
    {
      id: "pin",
      label: tab.pinned ? "Unpin tab" : "Pin tab",
      testId: "workspace-menu-pin",
      onSelect: () =>
        dispatch({ type: tab.pinned ? "unpin" : "pin", tabId: tab.id }),
    },
    {
      id: "side",
      label: "Open to the side",
      hint: can.side ? shortKeys("workspaceSplit", IS_MAC) : FULL,
      disabled: !can.side,
      testId: "workspace-menu-side",
      onSelect: () => dispatch({ type: "split", tabId: tab.id }),
    },
    {
      id: "left",
      label: "Move to the left pane",
      disabled: !can.left,
      testId: "workspace-menu-left",
      onSelect: () => moveBy(-1),
    },
    {
      id: "right",
      label: "Move to the right pane",
      disabled: !can.right,
      testId: "workspace-menu-right",
      onSelect: () => moveBy(1),
    },
    {
      id: "new",
      label: "Move to a new pane",
      disabled: !can.newPane,
      testId: "workspace-menu-new",
      onSelect: () =>
        dispatch({ type: "moveToNewPane", tabId: tab.id, paneId: pane.id }),
    },
    {
      id: "close",
      label: "Close tab",
      hint: can.close ? shortKeys("workspaceClose", IS_MAC) : "Unpin first",
      disabled: !can.close,
      testId: "workspace-menu-close",
      onSelect: () => dispatch({ type: "close", tabId: tab.id }),
    },
    {
      id: "others",
      label: "Close other tabs",
      hint: "Keeps pinned tabs",
      disabled: !can.closeOthers,
      testId: "workspace-menu-others",
      onSelect: () => dispatch({ type: "closeOthers", tabId: tab.id }),
    },
  ];
}

/** Left, Right, Home and End move the focus along the strip; Delete closes. */
function onTabKey(
  event: KeyboardEvent<HTMLButtonElement>,
  pane: WorkspacePane,
  tab: WorkspaceTab,
): void {
  const native = event.nativeEvent;
  const button = event.currentTarget;
  if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
    event.preventDefault();
    openMenuAt(button);
    return;
  }
  if (matchesShortcut("workspaceClose", native, IS_MAC)) {
    if (tab.pinned) return;
    event.preventDefault();
    flushSync(() =>
      useWorkspace.getState().dispatch({ type: "close", tabId: tab.id }),
    );
    const after = useWorkspace
      .getState()
      .layout.panes.find((p) => p.id === pane.id);
    focusTab(after?.active ?? null);
    return;
  }
  const tabs = pane.tabs;
  const at = tabs.findIndex((t) => t.id === tab.id);
  let to = -1;
  if (matchesShortcut("workspaceTabs", native, IS_MAC)) {
    const step = event.key === "ArrowLeft" ? -1 : 1;
    to = (at + step + tabs.length) % tabs.length;
  } else if (event.key === "Home") {
    to = 0;
  } else if (event.key === "End") {
    to = tabs.length - 1;
  }
  if (to < 0) return;
  event.preventDefault();
  focusTab(tabs[to].id);
}

function TabItem(props: {
  pane: WorkspacePane;
  index: number;
  tab: WorkspaceTab;
  can: TabActions;
}) {
  const { pane, index, tab, can } = props;
  const name = useClusterName(tab.clusterId);
  const state = useWorkspaceClusterState(tab.clusterId);
  const status = clusterStatus(state);
  const dispatch = useWorkspace((s) => s.dispatch);
  const selected = pane.active === tab.id;
  const label = tabLabel(name, tab.view);

  function onAuxClick(event: MouseEvent<HTMLButtonElement>): void {
    if (event.button !== 1 || tab.pinned) return;
    event.preventDefault();
    dispatch({ type: "close", tabId: tab.id });
  }

  const button = (
    <button
      type="button"
      role="tab"
      id={tabElementId(tab.id)}
      className={styles.button}
      aria-selected={selected}
      aria-label={tab.pinned ? `${label}, pinned` : label}
      tabIndex={selected ? 0 : -1}
      data-testid="workspace-tab"
      data-cluster={tab.clusterId}
      data-view={tab.view}
      data-pinned={tab.pinned}
      onClick={() => dispatch({ type: "activate", tabId: tab.id })}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={onAuxClick}
      onKeyDown={(e) => onTabKey(e, pane, tab)}
    >
      <span
        className={styles.tile}
        style={{ backgroundColor: clusterColor(tab.clusterId) }}
      >
        {clusterInitials(name)}
        <span className={styles.dot}>
          <StatusDot tone={status.tone} label={status.label} />
        </span>
      </span>
      {tab.pinned ? null : <span className={styles.label}>{label}</span>}
    </button>
  );

  const close: ReactElement = can.close ? (
    <IconButton
      className={styles.action}
      label="Close tab"
      icon={<X size={12} aria-hidden="true" />}
      tabIndex={-1}
      data-testid="workspace-tab-close"
      onClick={() => dispatch({ type: "close", tabId: tab.id })}
    />
  ) : (
    <Tooltip content="Unpin first">
      <span className={styles.blocked}>
        <IconButton
          className={styles.action}
          label="Close tab"
          tooltip={false}
          icon={<X size={12} aria-hidden="true" />}
          tabIndex={-1}
          disabled
          data-testid="workspace-tab-close"
        />
      </span>
    </Tooltip>
  );

  return (
    <ContextMenu
      label={`Actions for ${label}`}
      items={menuItems(pane, index, tab, can)}
    >
      <div
        role="presentation"
        className={styles.tab}
        data-selected={selected}
        data-pinned={tab.pinned}
      >
        {tab.pinned ? <Tooltip content={label}>{button}</Tooltip> : button}
        <span className={styles.actions}>
          <IconButton
            className={styles.action}
            label={tab.pinned ? "Unpin tab" : "Pin tab"}
            icon={
              tab.pinned ? (
                <PinOff size={12} aria-hidden="true" />
              ) : (
                <Pin size={12} aria-hidden="true" />
              )
            }
            tabIndex={-1}
            data-testid="workspace-tab-pin"
            onClick={() =>
              dispatch({ type: tab.pinned ? "unpin" : "pin", tabId: tab.id })
            }
          />
          {close}
        </span>
      </div>
    </ContextMenu>
  );
}

function SplitButton(props: { pane: WorkspacePane; full: boolean }) {
  const tab = activeTab(props.pane);
  const name = useClusterName(tab?.clusterId ?? "");
  const dispatch = useWorkspace((s) => s.dispatch);
  if (!tab) return null;
  const label = `Split right: open ${name} beside this pane`;
  const icon = <Columns2 size={14} aria-hidden="true" />;
  if (props.full) {
    return (
      <Tooltip content={FULL}>
        <span className={styles.blocked}>
          <IconButton
            className={styles.split}
            label={label}
            tooltip={false}
            icon={icon}
            disabled
            data-testid="workspace-split"
          />
        </span>
      </Tooltip>
    );
  }
  return (
    <IconButton
      className={styles.split}
      label={label}
      icon={icon}
      data-testid="workspace-split"
      onClick={() => dispatch({ type: "split", tabId: tab.id })}
    />
  );
}

/** The tabs of one pane, then the split button (spec E §15.3). */
export function TabStrip(props: { pane: WorkspacePane; index: number }) {
  const { pane, index } = props;
  const layout = useWorkspace((s) => s.layout);
  return (
    <div className={styles.strip}>
      <div
        role="tablist"
        aria-label={`Tabs in pane ${index + 1}`}
        className={styles.tabs}
        data-testid="workspace-strip"
      >
        {pane.tabs.map((tab) => {
          const can = tabActions(layout, tab.id);
          return can ? (
            <TabItem
              key={tab.id}
              pane={pane}
              index={index}
              tab={tab}
              can={can}
            />
          ) : null;
        })}
      </div>
      <SplitButton pane={pane} full={layout.panes.length >= MAX_PANES} />
    </div>
  );
}
