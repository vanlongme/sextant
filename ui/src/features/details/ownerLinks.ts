import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { groupSegment } from "../../kinds/nav";

/** The API group in an `apiVersion` such as `apps/v1`; "" for `v1`. */
function groupOf(apiVersion: string): string {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? "" : apiVersion.slice(0, slash);
}

/**
 * The route to an owner, relative to its cluster: the owner's list with the owner
 * selected in the `object` search param. Prefix it with `/cluster/<id>`. It is null
 * when no served resource has the owner's kind, so the owner has nowhere to link to.
 * An owner is in the namespace of what it owns, or is cluster-scoped.
 */
export function ownerTarget(
  owner: { kind: string; name: string; apiVersion?: string },
  namespace: string | undefined,
  resources: ApiResourceInfo[],
): string | null {
  const group =
    owner.apiVersion === undefined ? null : groupOf(owner.apiVersion);
  const found = resources.find(
    (r) =>
      r.resource.kind === owner.kind &&
      (group === null || r.resource.group === group),
  );
  if (!found) return null;
  const { resource } = found;
  const ns = resource.namespaced ? (namespace ?? "") : "";
  const object = encodeURIComponent(`${ns}/${owner.name}`);
  return `/r/${encodeURIComponent(groupSegment(resource.group))}/${encodeURIComponent(resource.plural)}?object=${object}`;
}
