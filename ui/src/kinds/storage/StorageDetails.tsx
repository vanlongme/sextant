import { Facts, ObjectLink, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import { accessModes, isDefaultStorageClass, pvcAccessModes } from "./storage";

export function PersistentVolumeDetail({
  clusterId,
  object,
  resources,
}: DetailProps) {
  const spec = object.spec ?? {};
  const claim = spec.claimRef;
  const claimLink = claim?.name ? (
    <ObjectLink
      clusterId={clusterId}
      resources={resources}
      kind="PersistentVolumeClaim"
      name={claim.name}
      namespace={claim.namespace}
    />
  ) : undefined;
  return (
    <Part title="Persistent volume">
      <Facts
        items={[
          ["Capacity", spec.capacity?.storage],
          ["Access modes", accessModes(spec.accessModes)],
          ["Reclaim policy", spec.persistentVolumeReclaimPolicy],
          ["Storage class", spec.storageClassName],
          ["Volume mode", spec.volumeMode],
          ["Claim", claimLink],
        ]}
      />
    </Part>
  );
}

export function PersistentVolumeClaimDetail({
  clusterId,
  object,
  resources,
}: DetailProps) {
  const spec = object.spec ?? {};
  const volumeLink = spec.volumeName ? (
    <ObjectLink
      clusterId={clusterId}
      resources={resources}
      kind="PersistentVolume"
      name={spec.volumeName}
    />
  ) : undefined;
  return (
    <Part title="Persistent volume claim">
      <Facts
        items={[
          ["Capacity", object.status?.capacity?.storage],
          ["Requested", spec.resources?.requests?.storage],
          ["Access modes", pvcAccessModes(object)],
          ["Storage class", spec.storageClassName],
          ["Volume mode", spec.volumeMode],
          ["Volume", volumeLink],
        ]}
      />
    </Part>
  );
}

export function StorageClassDetail({ object }: DetailProps) {
  const parameters = Object.entries(
    (object.parameters ?? {}) as Record<string, string>,
  ).sort(([a], [b]) => a.localeCompare(b));
  const mountOptions: string[] = Array.isArray(object.mountOptions)
    ? object.mountOptions
    : [];
  return (
    <>
      <Part title="Storage class">
        <Facts
          items={[
            ["Provisioner", object.provisioner],
            ["Reclaim policy", object.reclaimPolicy],
            ["Binding mode", object.volumeBindingMode],
            ["Volume expansion", object.allowVolumeExpansion ? "Yes" : "No"],
            ["Default", isDefaultStorageClass(object) ? "Yes" : "No"],
            ["Mount options", mountOptions.join(", ")],
          ]}
        />
      </Part>
      <Part title="Parameters">
        <SimpleTable
          testId="detail-storageclass-parameters"
          headers={["Name", "Value"]}
          rows={parameters.map(([k, v]) => [k, v])}
          empty="No parameters."
        />
      </Part>
    </>
  );
}
