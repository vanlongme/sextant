import { createHashRouter, Navigate, useParams } from "react-router";
import { CatalogScreen } from "../features/catalog/CatalogScreen";
import { PreferencesScreen } from "../features/prefs/PreferencesScreen";
import { useCatalog } from "../stores/catalog";
import { Shell } from "./Shell";
import styles from "./Shell.module.css";

function ClusterPlaceholder() {
  const { id } = useParams();
  const cluster = useCatalog((s) => s.clusters.find((c) => c.id === id));
  return (
    <div className={styles.placeholder}>
      <h2>{cluster?.name ?? id}</h2>
    </div>
  );
}

/** A router over the current hash. */
export function createAppRouter() {
  return createHashRouter([
    {
      path: "/",
      element: <Shell />,
      children: [
        { index: true, element: <Navigate to="/catalog" replace /> },
        { path: "catalog", element: <CatalogScreen /> },
        { path: "cluster/:id", element: <ClusterPlaceholder /> },
        { path: "preferences", element: <PreferencesScreen /> },
      ],
    },
  ]);
}
