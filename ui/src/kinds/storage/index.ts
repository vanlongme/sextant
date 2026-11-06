import { baseColumns, statusColumn, textColumn } from "../columns";
import { registerKind } from "../registry";
import {
  PersistentVolumeClaimDetail,
  PersistentVolumeDetail,
  StorageClassDetail,
} from "./StorageDetails";
import {
  accessModes,
  isDefaultStorageClass,
  pvClaim,
  pvcAccessModes,
  pvcStatus,
  pvStatus,
} from "./storage";

registerKind("", "persistentvolumes", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("capacity", "Capacity", (o) => o.spec?.capacity?.storage),
      textColumn("accessModes", "Access modes", (o) =>
        accessModes(o.spec?.accessModes),
      ),
      textColumn(
        "reclaimPolicy",
        "Reclaim policy",
        (o) => o.spec?.persistentVolumeReclaimPolicy,
      ),
      statusColumn(pvStatus),
      textColumn("claim", "Claim", pvClaim),
      textColumn(
        "storageClass",
        "Storage class",
        (o) => o.spec?.storageClassName,
      ),
    ),
  detail: PersistentVolumeDetail,
});

registerKind("", "persistentvolumeclaims", {
  columns: (info) =>
    baseColumns(
      info.resource,
      statusColumn(pvcStatus),
      textColumn("volume", "Volume", (o) => o.spec?.volumeName),
      textColumn("capacity", "Capacity", (o) => o.status?.capacity?.storage),
      textColumn("accessModes", "Access modes", pvcAccessModes),
      textColumn(
        "storageClass",
        "Storage class",
        (o) => o.spec?.storageClassName,
      ),
    ),
  detail: PersistentVolumeClaimDetail,
});

registerKind("storage.k8s.io", "storageclasses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("provisioner", "Provisioner", (o) => o.provisioner),
      textColumn("reclaimPolicy", "Reclaim policy", (o) => o.reclaimPolicy),
      textColumn("bindingMode", "Binding mode", (o) => o.volumeBindingMode),
      textColumn("expansion", "Expansion", (o) =>
        o.allowVolumeExpansion ? "Yes" : "-",
      ),
      textColumn("default", "Default", (o) =>
        isDefaultStorageClass(o) ? "Yes" : "-",
      ),
    ),
  detail: StorageClassDetail,
});
