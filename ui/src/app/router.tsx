import { createHashRouter, Navigate } from "react-router";
import { CatalogScreen } from "../features/catalog/CatalogScreen";
import { ClusterOverview } from "../features/cluster/ClusterHome";
import { ClusterScreen } from "../features/cluster/ClusterScreen";
import { HelmChartsRoute } from "../features/helm/HelmChartsScreen";
import {
  HelmInstallRoute,
  HelmUpgradeRoute,
} from "../features/helm/HelmFormScreen";
import { HelmReleasesRoute } from "../features/helm/HelmReleasesScreen";
import { MapRoute } from "../features/map/MapRoute";
import { PortForwardsRoute } from "../features/portForward/PortForwardsScreen";
import { PreferencesScreen } from "../features/prefs/PreferencesScreen";
import { ResourceRoute } from "../features/resources/ResourceScreen";
import { ClusterSettingsRoute } from "../features/settings/ClusterSettingsScreen";
import { WorkloadsOverview } from "../features/workloads/WorkloadsOverview";
import { WorkspaceScreen } from "../features/workspace/WorkspaceScreen";
import { Shell } from "./Shell";

/** A router over the current hash. */
export function createAppRouter() {
  return createHashRouter([
    {
      path: "/",
      element: <Shell />,
      children: [
        { index: true, element: <Navigate to="/catalog" replace /> },
        { path: "catalog", element: <CatalogScreen /> },
        {
          path: "cluster/:id",
          element: <ClusterScreen />,
          children: [
            { index: true, element: <ClusterOverview /> },
            { path: "workloads", element: <WorkloadsOverview /> },
            { path: "r/:group/:plural", element: <ResourceRoute /> },
            { path: "port-forwards", element: <PortForwardsRoute /> },
            { path: "helm/charts", element: <HelmChartsRoute /> },
            { path: "helm/releases", element: <HelmReleasesRoute /> },
            { path: "helm/install", element: <HelmInstallRoute /> },
            {
              path: "helm/upgrade/:namespace/:name",
              element: <HelmUpgradeRoute />,
            },
            { path: "settings", element: <ClusterSettingsRoute /> },
            { path: "map", element: <MapRoute /> },
          ],
        },
        { path: "preferences", element: <PreferencesScreen /> },
        { path: "workspace", element: <WorkspaceScreen /> },
      ],
    },
  ]);
}
