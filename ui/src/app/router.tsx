import { createHashRouter, Navigate } from "react-router";
import { CatalogScreen } from "../features/catalog/CatalogScreen";
import { ClusterScreen } from "../features/cluster/ClusterScreen";
import { PreferencesScreen } from "../features/prefs/PreferencesScreen";
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
        { path: "cluster/:id", element: <ClusterScreen /> },
        { path: "preferences", element: <PreferencesScreen /> },
      ],
    },
  ]);
}
