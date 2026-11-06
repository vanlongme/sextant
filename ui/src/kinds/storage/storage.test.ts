import { expect, test } from "vitest";
import {
  accessModes,
  isDefaultStorageClass,
  pvcStatus,
  pvStatus,
} from "./storage";

const m = { name: "x" };

test("access modes use kubectl's short forms", () => {
  expect(
    accessModes([
      "ReadWriteOnce",
      "ReadOnlyMany",
      "ReadWriteMany",
      "ReadWriteOncePod",
    ]),
  ).toBe("RWO,ROX,RWX,RWOP");
  expect(accessModes(undefined)).toBe("");
});

test.each([
  ["Bound", "ok"],
  ["Available", "ok"],
  ["Released", "warn"],
  ["Pending", "warn"],
  ["Failed", "danger"],
  ["Lost", "danger"],
])("volume phase %s is %s", (phase, tone) => {
  expect(pvStatus({ metadata: m, status: { phase } })).toEqual({
    label: phase,
    tone,
  });
  expect(pvcStatus({ metadata: m, status: { phase } })).toEqual({
    label: phase,
    tone,
  });
});

test("terminating and missing phases", () => {
  expect(
    pvcStatus({
      metadata: { ...m, deletionTimestamp: "x" },
      status: { phase: "Bound" },
    }),
  ).toEqual({ label: "Terminating", tone: "neutral" });
  expect(pvStatus({ metadata: m })).toEqual({
    label: "Unknown",
    tone: "neutral",
  });
});

test("default class annotations", () => {
  const with_ = (key: string, value: string) => ({
    metadata: { ...m, annotations: { [key]: value } },
  });
  expect(
    isDefaultStorageClass(
      with_("storageclass.kubernetes.io/is-default-class", "true"),
    ),
  ).toBe(true);
  expect(
    isDefaultStorageClass(
      with_("storageclass.beta.kubernetes.io/is-default-class", "true"),
    ),
  ).toBe(true);
  expect(
    isDefaultStorageClass(
      with_("storageclass.kubernetes.io/is-default-class", "false"),
    ),
  ).toBe(false);
  expect(isDefaultStorageClass({ metadata: m })).toBe(false);
});
