import { createContext } from "react";
import { servedResourceOf } from "../../features/details/ownerLinks";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";

/** An object a drawer can show: the served resource and the object's name. */
export interface DrawerTarget {
  group: string;
  plural: string;
  namespace: string | null;
  name: string;
}

/** "<group>/<plural>/<namespace or empty>/<name>" */
export function targetKey(t: DrawerTarget): string {
  return `${t.group}/${t.plural}/${t.namespace ?? ""}/${t.name}`;
}

/**
 * The drawer target of a reference, found as `ownerTarget` finds its list; null when no
 * served resource has that kind. A cluster-scoped kind drops the namespace.
 */
export function objectTarget(
  ref: { kind: string; name: string; apiVersion?: string },
  namespace: string | undefined,
  resources: ApiResourceInfo[],
): DrawerTarget | null {
  const found = servedResourceOf(ref, resources);
  if (!found) return null;
  const { group, plural, namespaced } = found.resource;
  return {
    group,
    plural,
    namespace: namespaced ? (namespace ?? null) : null,
    name: ref.name,
  };
}

/** Set by the details drawer: links inside it open their object in the same drawer. */
export const DrawerLinkContext = createContext<{
  open(target: DrawerTarget): void;
} | null>(null);
