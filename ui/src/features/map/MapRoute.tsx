import { useSearchParams } from "react-router";
import { ClusterMapScreen } from "./ClusterMapScreen";
import { ObjectMapScreen } from "./ObjectMapScreen";

/** `cluster/:id/map`: the cluster map, or with `?focus=` an object map (spec E §5). */
export function MapRoute() {
  const [params] = useSearchParams();
  const focus = params.get("focus");
  return focus ? <ObjectMapScreen focusId={focus} /> : <ClusterMapScreen />;
}
