import { expect, test } from "vitest";
import { internalIp, nodeRoles, nodeStatus, taintText } from "./node";

const m = { name: "n" };
const ready = (status: string) => ({
  status: { conditions: [{ type: "Ready", status }] },
});

test.each([
  ["ready", { metadata: m, ...ready("True") }, "Ready", "ok"],
  ["not ready", { metadata: m, ...ready("False") }, "NotReady", "danger"],
  [
    "unknown counts as not ready, as kubectl prints it",
    { metadata: m, ...ready("Unknown") },
    "NotReady",
    "danger",
  ],
  ["no conditions", { metadata: m }, "Unknown", "neutral"],
  [
    "cordoned",
    { metadata: m, spec: { unschedulable: true }, ...ready("True") },
    "Ready,SchedulingDisabled",
    "warn",
  ],
  [
    "cordoned and down",
    { metadata: m, spec: { unschedulable: true }, ...ready("False") },
    "NotReady,SchedulingDisabled",
    "danger",
  ],
])("node %s", (_n, object, label, tone) => {
  expect(nodeStatus(object)).toEqual({ label, tone });
});

test("roles come from labels, sorted, as kubectl finds them", () => {
  expect(
    nodeRoles({
      metadata: {
        ...m,
        labels: {
          "node-role.kubernetes.io/worker": "",
          "node-role.kubernetes.io/control-plane": "",
          "kubernetes.io/role": "gpu",
          other: "x",
        },
      },
    }),
  ).toBe("control-plane,gpu,worker");
  expect(nodeRoles({ metadata: m })).toBe("<none>");
});

test("taint text", () => {
  expect(taintText({ key: "k", value: "v", effect: "NoSchedule" })).toBe(
    "k=v:NoSchedule",
  );
  expect(taintText({ key: "k", effect: "NoExecute" })).toBe("k:NoExecute");
});

test("internal IP", () => {
  expect(
    internalIp({
      metadata: m,
      status: {
        addresses: [
          { type: "Hostname", address: "h" },
          { type: "InternalIP", address: "1.2.3.4" },
        ],
      },
    }),
  ).toBe("1.2.3.4");
  expect(internalIp({ metadata: m })).toBeUndefined();
});
