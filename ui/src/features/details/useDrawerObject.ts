import { useEffect, useRef, useState } from "react";
import { api } from "../../ipc/api";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { type DrawerTarget, targetKey } from "../../kinds/detail/links";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { rowsAreTrimmed, useResourceList } from "../../stores/resources";
import { useWholeObject } from "./useWholeObject";

export type DrawerObjectStatus =
  | "loading"
  | "live"
  | "fetched"
  | "deleted"
  | "notFound"
  | "forbidden"
  | "notServed"
  | "error";

export interface DrawerObject {
  status: DrawerObjectStatus;
  /** The object to show: live, fetched, last seen, or null. */
  object: KubeObject | null;
  /** The backend's message for forbidden, notServed and error. */
  message: string | null;
  retry(): void;
}

/** Stands in for a missing resource; `useWholeObject` reads it only with a key. */
const NONE: ResourceRef = {
  group: "",
  version: "",
  plural: "",
  kind: "",
  namespaced: false,
};

const NOOP = () => {};

interface Answer {
  owner: string;
  object: KubeObject | null;
  code: string | null;
  message: string | null;
}

/** One `resourceGet` for the target while `wanted`, again on retry. */
function useOneGet(
  clusterId: string,
  resource: ResourceRef | null,
  target: DrawerTarget | null,
  wanted: boolean,
): { answer: Answer | null; retry(): void } {
  const owner =
    wanted && resource && target
      ? `${clusterId}\n${resource.group}/${resource.plural}\n${targetKey(target)}`
      : "";
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The effect runs on `owner` and `attempt`; it reads the rest here.
  const latest = useRef({ clusterId, resource, target });
  latest.current = { clusterId, resource, target };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the get.
  useEffect(() => {
    const { clusterId: cluster, resource: ref, target: t } = latest.current;
    if (owner === "" || ref === null || t === null) return;
    // Only the answer to the latest request is kept.
    let current = true;
    api.resourceGet(cluster, ref, t.namespace, t.name).then(
      (value) => {
        if (current) {
          setAnswer({
            owner,
            object: value as KubeObject,
            code: null,
            message: null,
          });
        }
      },
      (error) => {
        if (current) {
          setAnswer({
            owner,
            object: null,
            code: error instanceof IpcFailure ? error.code : null,
            message: failureMessage(error),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [owner, attempt]);

  return {
    answer: owner !== "" && answer?.owner === owner ? answer : null,
    retry: () => {
      setAnswer(null);
      setAttempt((a) => a + 1);
    },
  };
}

/**
 * The object a drawer entry shows, and its state (spec H49, H50). A listable kind reads
 * the shared live list, so a link to the screen's own kind shares its subscription; an
 * object the synced list lacks is confirmed with one `resourceGet`. A kind the user
 * cannot list or watch is read with one `resourceGet`, again on Retry. Secrets come
 * blanked from both reads (H53).
 */
export function useDrawerObject(
  clusterId: string,
  info: ApiResourceInfo | undefined,
  target: DrawerTarget | null,
  lastSeen: KubeObject | null,
): DrawerObject {
  const listing = info !== undefined && info.canList && target !== null;
  const list = useResourceList(clusterId, listing ? info.resource : null);
  const listUsable =
    listing && list.status !== "forbidden" && list.status !== "notServed";
  const key = target ? `${target.namespace ?? ""}/${target.name}` : null;
  const found =
    listUsable && key !== null
      ? list.items.find((o) => objectKey(o) === key)
      : undefined;
  // A trimmed row lacks what the drawer shows, so the drawer shows the fetched object.
  const whole = useWholeObject(
    clusterId,
    info?.resource ?? NONE,
    listUsable ? key : null,
    found,
  );
  const needGet =
    info !== undefined &&
    target !== null &&
    (!info.canList ||
      list.status === "forbidden" ||
      (listUsable &&
        !list.loading &&
        found === undefined &&
        lastSeen === null));
  const get = useOneGet(clusterId, info?.resource ?? null, target, needGet);

  const state = (
    status: DrawerObjectStatus,
    object: KubeObject | null = null,
    message: string | null = null,
    retry: () => void = NOOP,
  ): DrawerObject => ({ status, object, message, retry });

  if (target === null) return state("loading");
  if (info === undefined) return state("notServed");
  if (listing && list.status === "notServed") {
    return state("notServed", null, list.message);
  }
  if (found) {
    if (!rowsAreTrimmed(info.resource)) return state("live", found);
    if (whole.error) {
      return state("error", whole.object, whole.error, whole.retry);
    }
    return whole.object ? state("live", whole.object) : state("loading");
  }
  if (listUsable && list.loading) return state("loading");
  if (listUsable && lastSeen) return state("deleted", lastSeen);
  const answer = get.answer;
  if (answer === null) return state("loading");
  if (answer.object) return state("fetched", answer.object, null, get.retry);
  if (answer.code === "NotFound")
    return state("notFound", null, answer.message);
  if (answer.code === "Forbidden" || answer.code === "Unauthorized") {
    return state("forbidden", null, answer.message, get.retry);
  }
  return state("error", null, answer.message, get.retry);
}
