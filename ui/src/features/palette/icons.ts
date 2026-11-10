import {
  ArrowRightLeft,
  Bell,
  Box,
  Boxes,
  CalendarClock,
  Copy,
  Cpu,
  Database,
  FileCog,
  FolderTree,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Package,
  PackageCheck,
  Puzzle,
  Rocket,
  ShieldCheck,
  Waypoints,
  Workflow,
} from "lucide-react";

/** The kinds of `resources_names`, by plural. */
export const KIND_ICONS: Partial<Record<string, LucideIcon>> = {
  pods: Box,
  deployments: Rocket,
  statefulsets: Database,
  daemonsets: Layers,
  replicasets: Copy,
  jobs: Workflow,
  cronjobs: CalendarClock,
  services: Waypoints,
  ingresses: Globe,
  configmaps: FileCog,
  secrets: KeyRound,
  persistentvolumeclaims: HardDrive,
  nodes: Cpu,
  namespaces: FolderTree,
};

/** Pages of other kinds take their sidebar section's icon. */
export const SECTION_ICONS: Partial<Record<string, LucideIcon>> = {
  nodes: Cpu,
  workloads: Boxes,
  config: FileCog,
  network: Network,
  storage: HardDrive,
  namespaces: FolderTree,
  events: Bell,
  helm: Package,
  access: ShieldCheck,
  custom: Puzzle,
};

export const ROUTE_ICONS: Partial<Record<string, LucideIcon>> = {
  "port-forwards": ArrowRightLeft,
  "helm/charts": Package,
  "helm/releases": PackageCheck,
};

export const OVERVIEW_ICON: LucideIcon = LayoutDashboard;
export const CUSTOM_ICON: LucideIcon = Puzzle;
export const FALLBACK_ICON: LucideIcon = Box;
