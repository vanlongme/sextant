import { create } from "zustand";

/** The shell dialogs: at most one is open (spec C §4.2). */
export type ShellDialogId = "palette" | "shortcuts" | "about";

interface ShellState {
  dialog: ShellDialogId | null;
  addClusterOpen: boolean;
  /** Replaces the open shell dialog. The open one again is a no-op, so a key that
   * both the macOS menu and the webview handle cannot toggle it shut. */
  open(dialog: ShellDialogId): void;
  /** Closes `dialog` if it is the open one, or whichever is open without one. */
  close(dialog?: ShellDialogId): void;
  openAddCluster(): void;
  closeAddCluster(): void;
}

export const useShell = create<ShellState>((set, get) => ({
  dialog: null,
  addClusterOpen: false,
  open(dialog) {
    if (get().dialog !== dialog) set({ dialog });
  },
  close(dialog) {
    const open = get().dialog;
    if (open === null || (dialog !== undefined && dialog !== open)) return;
    set({ dialog: null });
  },
  openAddCluster() {
    if (!get().addClusterOpen) set({ addClusterOpen: true });
  },
  closeAddCluster() {
    if (get().addClusterOpen) set({ addClusterOpen: false });
  },
}));

export function resetShellForTest(): void {
  useShell.setState({ dialog: null, addClusterOpen: false });
}
