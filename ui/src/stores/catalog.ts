import { create, type StoreApi, type UseBoundStore } from "zustand";
import { toast } from "../design";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import { events } from "../ipc/events";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import type { SyncWarning } from "../ipc/generated/SyncWarning";

export interface CatalogState {
  clusters: ClusterEntry[];
  warnings: SyncWarning[];
  hotbar: string[];
  loading: boolean;
  error: string | null;
  /** Loads and subscribes to events exactly once. */
  init(): Promise<void>;
  /** Reads everything again, as after a failed load. */
  reload(): Promise<void>;
  pin(id: string): Promise<void>;
  unpin(id: string): Promise<void>;
  reorderHotbar(ids: string[]): Promise<void>;
}

const EMPTY = {
  clusters: [],
  warnings: [],
  hotbar: [],
  loading: true,
  error: null,
} satisfies Partial<CatalogState>;

let started: Promise<void> | null = null;

// The last load wins. State events that arrive while a list is on its way are
// newer than that list, so they are applied over it.
let loadSeq = 0;
let statesDuringLoad = new Map<string, ConnectionState>();

// Writes run one at a time, because the backend handles commands concurrently
// and an older list must never land last.
let writes: Promise<unknown> = Promise.resolve();
let writeSeq = 0;
let savedHotbar: string[] = [];

function withStates(
  clusters: ClusterEntry[],
  states: Map<string, ConnectionState>,
): ClusterEntry[] {
  return clusters.map((cluster) => {
    const state = states.get(cluster.id);
    return state ? { ...cluster, state } : cluster;
  });
}

export const useCatalog: UseBoundStore<StoreApi<CatalogState>> =
  create<CatalogState>((set, get) => {
    async function load(): Promise<void> {
      const seq = ++loadSeq;
      const writesAtStart = writeSeq;
      statesDuringLoad = new Map();
      try {
        await writes;
        const [clusters, warnings, hotbar] = await Promise.all([
          api.catalogList(),
          api.catalogWarnings(),
          api.hotbarGet(),
        ]);
        if (seq !== loadSeq) return;
        set({
          clusters: withStates(clusters, statesDuringLoad),
          warnings,
          loading: false,
          error: null,
        });
        if (writesAtStart === writeSeq) {
          savedHotbar = hotbar;
          set({ hotbar });
        }
      } catch (error) {
        if (seq === loadSeq) {
          set({ loading: false, error: failureMessage(error) });
        }
      }
    }

    async function subscribe(): Promise<void> {
      await Promise.all([
        events.onCatalogChanged(() => void load()),
        events.onKubeconfigWarnings((warnings) => set({ warnings })),
        events.onClusterState(({ id, state }) => {
          statesDuringLoad.set(id, state);
          set({
            clusters: withStates(get().clusters, new Map([[id, state]])),
          });
        }),
      ]);
    }

    async function writeHotbar(next: string[]): Promise<void> {
      const seq = ++writeSeq;
      set({ hotbar: next });
      const write = writes.then(() => api.hotbarSet(next));
      writes = write.catch(() => {});
      try {
        await write;
        savedHotbar = next;
      } catch (error) {
        // A newer list is already on its way and includes this change.
        if (seq === writeSeq) set({ hotbar: savedHotbar });
        toast.error("Could not save the hotbar", failureMessage(error));
      }
    }

    return {
      ...EMPTY,
      init() {
        started ??= subscribe()
          .then(load)
          .catch((error) => {
            set({ loading: false, error: failureMessage(error) });
          });
        return started;
      },
      reload() {
        set({ loading: true, error: null });
        return load();
      },
      async pin(id) {
        const { hotbar } = get();
        if (!hotbar.includes(id)) await writeHotbar([...hotbar, id]);
      },
      async unpin(id) {
        const { hotbar } = get();
        if (hotbar.includes(id)) {
          await writeHotbar(hotbar.filter((other) => other !== id));
        }
      },
      reorderHotbar: writeHotbar,
    };
  });

/**
 * Puts the store back to its first-run state, for a test that mocks a fresh
 * backend, whose listeners start empty.
 */
export function resetCatalogForTest(): void {
  started = null;
  loadSeq = 0;
  writes = Promise.resolve();
  writeSeq = 0;
  savedHotbar = [];
  statesDuringLoad = new Map();
  useCatalog.setState(EMPTY);
}
