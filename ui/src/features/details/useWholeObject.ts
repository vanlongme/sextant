import { useEffect, useRef, useState } from "react";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import { rowsAreTrimmed } from "../../stores/resources";

export interface WholeObject {
  /** The last object fetched for this key. It stays after the row is deleted. */
  object: KubeObject | null;
  /** Why the latest fetch failed, while the row is still in the list. */
  error: string | null;
  retry(): void;
}

interface Fetched {
  /** Which cluster, resource and object `object` belongs to. */
  owner: string;
  object: KubeObject | null;
  error: string | null;
}

/**
 * The whole object behind a trimmed row, for the detail drawer. It is fetched with
 * `resourceGet` when `objectKey` (`<namespace>/<name>`) opens, and again when the row's
 * `metadata.resourceVersion` changes. Between fetches the last object stays, so an update
 * does not blank the drawer. For a resource whose rows are whole, nothing is fetched and
 * `object` stays null.
 */
export function useWholeObject(
  clusterId: string,
  resource: ResourceRef,
  objectKey: string | null,
  row: KubeObject | undefined,
): WholeObject {
  const enabled = objectKey !== null && rowsAreTrimmed(resource);
  const owner = enabled
    ? `${clusterId}\n${resource.group}/${resource.plural}\n${objectKey}`
    : "";
  const [fetched, setFetched] = useState<Fetched>({
    owner,
    object: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  // Another object, or the same one opened again, starts with nothing fetched.
  if (fetched.owner !== owner) {
    setFetched({ owner, object: null, error: null });
  }
  const mine = fetched.owner === owner ? fetched : null;

  const rowVersion = row?.metadata.resourceVersion;
  const haveVersion = mine?.object?.metadata.resourceVersion;
  // A deleted row fetches nothing: the last object stays with the "deleted" notice.
  const wanted =
    enabled &&
    row !== undefined &&
    (mine?.object == null || haveVersion !== rowVersion);

  // The effect runs on `owner`, the row's version and `attempt`; it reads the rest here.
  const latest = useRef({ clusterId, resource, objectKey });
  latest.current = { clusterId, resource, objectKey };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `rowVersion` and `attempt` re-run the fetch.
  useEffect(() => {
    if (!wanted) return;
    const {
      clusterId: cluster,
      resource: ref,
      objectKey: key,
    } = latest.current;
    if (key === null) return;
    const slash = key.indexOf("/");
    const namespace = slash > 0 ? key.slice(0, slash) : null;
    const name = key.slice(slash + 1);
    // Only the answer to the latest request is kept, so an older version never
    // replaces a newer one.
    let current = true;
    api.resourceGet(cluster, ref, namespace, name).then(
      (value) => {
        if (current) {
          setFetched({ owner, object: value as KubeObject, error: null });
        }
      },
      (error) => {
        if (current) {
          setFetched((f) =>
            f.owner === owner ? { ...f, error: failureMessage(error) } : f,
          );
        }
      },
    );
    return () => {
      current = false;
    };
  }, [wanted, owner, rowVersion, attempt]);

  return {
    object: mine?.object ?? null,
    error: row !== undefined ? (mine?.error ?? null) : null,
    retry: () => {
      setFetched((f) => (f.owner === owner ? { ...f, error: null } : f));
      setAttempt((a) => a + 1);
    },
  };
}
