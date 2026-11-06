import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

type Obj = Pick<KubeObject, "metadata"> & Partial<KubeObject>;

const SHORT_MODES: Record<string, string> = {
  ReadWriteOnce: "RWO",
  ReadOnlyMany: "ROX",
  ReadWriteMany: "RWX",
  ReadWriteOncePod: "RWOP",
};

/** Access modes in kubectl's short forms, joined with commas. */
export function accessModes(modes: unknown): string {
  if (!Array.isArray(modes)) return "";
  return modes.map((m) => SHORT_MODES[String(m)] ?? String(m)).join(",");
}

const PHASE_TONES: Record<string, StatusInfo["tone"]> = {
  Bound: "ok",
  Available: "ok",
  Released: "warn",
  Pending: "warn",
  Failed: "danger",
  Lost: "danger",
};

function volumePhase(o: Obj): StatusInfo {
  if (o.metadata.deletionTimestamp) {
    return { label: "Terminating", tone: "neutral" };
  }
  const phase: string | undefined = o.status?.phase;
  if (!phase) return { label: "Unknown", tone: "neutral" };
  return { label: phase, tone: PHASE_TONES[phase] ?? "neutral" };
}

export const pvStatus = volumePhase;
export const pvcStatus = volumePhase;

export function isDefaultStorageClass(o: Obj): boolean {
  const annotations = o.metadata.annotations ?? {};
  return (
    annotations["storageclass.kubernetes.io/is-default-class"] === "true" ||
    annotations["storageclass.beta.kubernetes.io/is-default-class"] === "true"
  );
}

/** `<namespace>/<name>` of the claim a volume is bound to. */
export function pvClaim(o: Obj): string {
  const ref = o.spec?.claimRef;
  if (!ref?.name) return "";
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

export function pvcAccessModes(o: Obj): string {
  return accessModes(o.status?.accessModes ?? o.spec?.accessModes);
}
