import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../objects";
import {
  PersistentVolumeClaimDetail,
  PersistentVolumeDetail,
  StorageClassDetail,
} from "./StorageDetails";

const ref = (
  plural: string,
  kind: string,
  namespaced: boolean,
): ResourceRef => ({
  group: "",
  version: "v1",
  plural,
  kind,
  namespaced,
});
const info = (r: ResourceRef) =>
  ({ resource: r }) as unknown as ApiResourceInfo;

function show(Detail: typeof PersistentVolumeDetail, object: KubeObject) {
  render(
    <MemoryRouter>
      <Detail
        clusterId="c"
        object={object}
        resource={ref("x", "X", false)}
        resources={[
          info(ref("persistentvolumeclaims", "PersistentVolumeClaim", true)),
          info(ref("persistentvolumes", "PersistentVolume", false)),
        ]}
      />
    </MemoryRouter>,
  );
}

test("a volume shows its facts and links its claim", () => {
  show(PersistentVolumeDetail, {
    metadata: { name: "pv1" },
    spec: {
      capacity: { storage: "10Gi" },
      accessModes: ["ReadWriteOnce"],
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: "fast",
      claimRef: { namespace: "app", name: "data" },
    },
  });
  expect(screen.getByText("10Gi")).toBeTruthy();
  expect(screen.getByText("RWO")).toBeTruthy();
  expect(screen.getByText("Retain")).toBeTruthy();
  expect(screen.getByText("fast")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "PersistentVolumeClaim data" }),
  ).toBeTruthy();
});

test("a claim links its volume", () => {
  show(PersistentVolumeClaimDetail, {
    metadata: { name: "data", namespace: "app" },
    spec: { volumeName: "pv1", storageClassName: "fast" },
    status: { capacity: { storage: "10Gi" }, accessModes: ["ReadWriteMany"] },
  });
  expect(screen.getByText("RWX")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "PersistentVolume pv1" }),
  ).toBeTruthy();
});

test("a storage class shows provisioner, parameters and default", () => {
  show(StorageClassDetail, {
    metadata: {
      name: "fast",
      annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
    },
    provisioner: "ebs.csi.aws.com",
    parameters: { type: "gp3" },
  });
  expect(screen.getByText("ebs.csi.aws.com")).toBeTruthy();
  expect(screen.getByText("gp3")).toBeTruthy();
  expect(screen.getByText("Default").nextSibling?.textContent).toBe("Yes");
});
