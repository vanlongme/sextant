import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceTab,
} from "../features/workspace/layout";
import { WorkspaceScreen } from "../features/workspace/WorkspaceScreen";
import type { JsonValue } from "../ipc/generated/serde_json/JsonValue";
import type { WatchEvent } from "../ipc/generated/WatchEvent";
import type { KubeObject } from "../kinds/objects";
import { type Backend, mockBackend } from "./ipc";
import { clusterSettings } from "./metrics";

export function wsTab(
  id: string,
  clusterId: string,
  over: Partial<WorkspaceTab> = {},
): WorkspaceTab {
  return { id, clusterId, view: "pods", pinned: false, ...over };
}

export function wsPane(
  id: string,
  tabs: WorkspaceTab[],
  active: string | null = tabs[0]?.id ?? null,
): WorkspacePane {
  return { id, tabs, active };
}

const EQUAL: Record<number, number[]> = {
  1: [1],
  2: [0.5, 0.5],
  3: [0.3333, 0.3333, 0.3334],
};

export function wsLayout(
  panes: WorkspacePane[],
  over: Partial<WorkspaceLayout> = {},
): WorkspaceLayout {
  return {
    version: 1,
    panes,
    focus: panes[0].id,
    widths: EQUAL[panes.length],
    seq: 10,
    ...over,
  };
}

/** The route and query the page navigated to. */
export function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{`${pathname}${search}`}</output>;
}

// biome-ignore lint/suspicious/noExplicitAny: command arguments are checked per test.
type Handler = (args: any) => unknown;

/**
 * Renders the Workspace page at /workspace with this saved layout. Every list watch
 * answers at once with `rows[plural]` (none: no answer yet). The clusters come from
 * the catalog store, so call `connectClusters` first.
 */
export async function showWorkspace(
  saved: WorkspaceLayout | null,
  options: {
    rows?: Record<string, KubeObject[]>;
    handlers?: Record<string, Handler>;
  } = {},
): Promise<Backend> {
  const backend = mockBackend({
    ui_state_get: () => saved,
    ui_state_set: () => null,
    cluster_settings_get: () => clusterSettings(),
    cluster_connect: () => null,
    resources_unsubscribe: () => null,
    resources_subscribe: (a: {
      resource: { plural: string };
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      const items = options.rows?.[a.resource.plural];
      if (items) {
        a.onEvent.onmessage({
          type: "snapshot",
          items: items as unknown as JsonValue[],
        });
      }
      return `sub-${a.resource.plural}`;
    },
    ...options.handlers,
  });
  render(
    <MemoryRouter initialEntries={["/workspace"]}>
      <Routes>
        <Route path="/workspace" element={<WorkspaceScreen />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
  await screen.findByTestId("workspace-summary");
  return backend;
}
