import { create } from "zustand";
import { applyTheme, toast } from "../design";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { Prefs } from "../ipc/generated/Prefs";
import type { SyncSource } from "../ipc/generated/SyncSource";
import type { Theme } from "../ipc/generated/Theme";

export interface PrefsState {
  prefs: Prefs | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  setTheme(theme: Theme): Promise<void>;
  addSource(source: SyncSource): Promise<void>;
  removeSource(path: string): Promise<void>;
}

/** A typed path with a trailing separator is a folder, anything else a file. */
export function classifySourcePath(text: string): SyncSource {
  const path = text.trim();
  return /[/\\]$/.test(path) ? { kind: "dir", path } : { kind: "file", path };
}

const FIRST = { prefs: null, loading: true, error: null };

export const usePrefs = create<PrefsState>((set, get) => {
  /** Shows the change at once; returns whether it was saved. */
  async function save(next: Prefs): Promise<boolean> {
    const previous = get().prefs;
    set({ prefs: next });
    try {
      await api.prefsSet(next);
      return true;
    } catch (error) {
      set({ prefs: previous });
      toast.error("Could not save preferences", failureMessage(error));
      return false;
    }
  }

  return {
    ...FIRST,
    async load() {
      set({ loading: true, error: null });
      try {
        set({ prefs: await api.prefsGet(), loading: false });
      } catch (error) {
        set({ loading: false, error: failureMessage(error) });
      }
    },
    async setTheme(theme) {
      const { prefs } = get();
      if (!prefs) return;
      applyTheme(theme);
      if (!(await save({ ...prefs, theme }))) applyTheme(prefs.theme);
    },
    async addSource(source) {
      const { prefs } = get();
      if (!prefs) return;
      await save({ ...prefs, syncSources: [...prefs.syncSources, source] });
    },
    async removeSource(path) {
      const { prefs } = get();
      if (!prefs) return;
      await save({
        ...prefs,
        syncSources: prefs.syncSources.filter((s) => s.path !== path),
      });
    },
  };
});

export function resetPrefsForTest(): void {
  usePrefs.setState(FIRST);
}
