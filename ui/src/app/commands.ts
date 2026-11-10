import {
  ArrowLeft,
  ArrowRight,
  Info,
  Keyboard,
  LayoutGrid,
  type LucideIcon,
  Monitor,
  Moon,
  Plus,
  Power,
  Settings,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { openTerminal } from "../features/dock/openTerminal";
import type { Theme } from "../ipc/generated/Theme";
import { disconnectCluster } from "../stores/clusters";
import { usePrefs } from "../stores/prefs";
import { useShell } from "../stores/shell";
import { type CurrentCluster, useCurrentCluster } from "./currentCluster";
import type { ShortcutId } from "./shortcuts";

/** What a command sees when it is listed and when it runs. */
export interface CommandContext {
  navigate(to: string | number): void;
  pathname: string;
  cluster: CurrentCluster | null;
}

export type CommandId =
  | "catalog"
  | "preferences"
  | "add-cluster"
  | "terminal"
  | "disconnect"
  | "shortcuts"
  | "about"
  | "theme-dark"
  | "theme-light"
  | "theme-system"
  | "back"
  | "forward";

export interface AppCommand {
  id: CommandId;
  /** A function, because two labels name the cluster. */
  label(ctx: CommandContext): string;
  icon: LucideIcon;
  shortcut?: ShortcutId;
  available(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void;
}

const always = () => true;

function connected(ctx: CommandContext): boolean {
  return ctx.cluster?.state.status === "connected";
}

function clusterName(ctx: CommandContext): string {
  return ctx.cluster?.name ?? "Cluster";
}

/** Navigates unless the route is already there, so a key that reaches the app twice
 * (the macOS menu and the webview) does not push a second history entry. */
function go(ctx: CommandContext, path: string): void {
  if (ctx.pathname !== path) ctx.navigate(path);
}

async function setTheme(theme: Theme): Promise<void> {
  // Bootstrap loads the preferences; a failed load is retried here.
  if (usePrefs.getState().prefs === null) await usePrefs.getState().load();
  await usePrefs.getState().setTheme(theme);
}

function theme(
  id: CommandId,
  label: string,
  icon: LucideIcon,
  value: Theme,
): AppCommand {
  return {
    id,
    label: () => label,
    icon,
    available: always,
    run: () => void setTheme(value),
  };
}

/** Spec C §4.1, in the palette's order. */
export const COMMANDS: readonly AppCommand[] = [
  {
    id: "catalog",
    label: () => "Go to the catalog",
    icon: LayoutGrid,
    available: always,
    run: (ctx) => go(ctx, "/catalog"),
  },
  {
    id: "preferences",
    label: () => "Open Preferences",
    icon: Settings,
    shortcut: "preferences",
    available: always,
    run: (ctx) => {
      useShell.getState().close();
      go(ctx, "/preferences");
    },
  },
  {
    id: "add-cluster",
    label: () => "Add a cluster",
    icon: Plus,
    available: always,
    run: (ctx) => {
      go(ctx, "/catalog");
      useShell.getState().openAddCluster();
    },
  },
  {
    id: "terminal",
    label: (ctx) => `Open a terminal in ${clusterName(ctx)}`,
    icon: SquareTerminal,
    shortcut: "terminal",
    available: connected,
    run: (ctx) => {
      if (ctx.cluster) openTerminal(ctx.cluster.id);
    },
  },
  {
    id: "disconnect",
    label: (ctx) => `Disconnect ${clusterName(ctx)}`,
    icon: Power,
    available: connected,
    run: (ctx) => {
      if (ctx.cluster) void disconnectCluster(ctx.cluster.id);
    },
  },
  {
    id: "shortcuts",
    label: () => "Show keyboard shortcuts",
    icon: Keyboard,
    shortcut: "shortcuts",
    available: always,
    run: () => useShell.getState().open("shortcuts"),
  },
  {
    id: "about",
    label: () => "About SkoposIDE",
    icon: Info,
    available: always,
    run: () => useShell.getState().open("about"),
  },
  theme("theme-dark", "Theme: Dark", Moon, "dark"),
  theme("theme-light", "Theme: Light", Sun, "light"),
  theme("theme-system", "Theme: System", Monitor, "system"),
  {
    id: "back",
    label: () => "Go back",
    icon: ArrowLeft,
    shortcut: "back",
    available: always,
    run: (ctx) => ctx.navigate(-1),
  },
  {
    id: "forward",
    label: () => "Go forward",
    icon: ArrowRight,
    shortcut: "forward",
    available: always,
    run: (ctx) => ctx.navigate(1),
  },
];

export function commandById(id: CommandId): AppCommand {
  const command = COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`no command ${id}`);
  return command;
}

/** Runs a command when it is available in this context. */
export function runCommand(id: CommandId, ctx: CommandContext): void {
  const command = commandById(id);
  if (command.available(ctx)) command.run(ctx);
}

/** The macOS menu's app items (spec C §9.2): `palette` opens the palette. */
export function runMenuCommand(id: string, ctx: CommandContext): void {
  if (id === "palette") useShell.getState().open("palette");
  else if (id === "about" || id === "preferences" || id === "shortcuts") {
    runCommand(id, ctx);
  }
}

export function useCommandContext(): CommandContext {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const cluster = useCurrentCluster();
  return useMemo(
    () => ({
      navigate: (to: string | number) => {
        if (typeof to === "number") void navigate(to);
        else void navigate(to);
      },
      pathname,
      cluster,
    }),
    [navigate, pathname, cluster],
  );
}
