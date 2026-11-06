import { createHashRouter, Navigate } from "react-router";
import { CatalogScreen } from "../features/catalog/CatalogScreen";
import { ClusterOverview } from "../features/cluster/ClusterHome";
import { WorkloadsOverview } from "../features/cluster/ClusterLayout";
import { ClusterScreen } from "../features/cluster/ClusterScreen";
import { PreferencesScreen } from "../features/prefs/PreferencesScreen";
import { ResourceRoute } from "../features/resources/ResourceScreen";
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
          ],
        },
        { path: "preferences", element: <PreferencesScreen /> },
      ],
    },
  ]);
}
