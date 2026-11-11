import { expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import { T0 } from "../../test/metrics";
import {
  liveText,
  rollingDomain,
  rollingMinutes,
  sumHistory,
  workloadPods,
} from "./rolling";

const MiB = 2 ** 20;

const HISTORY = {
  "shop/web-1": [
    { t: T0, cpu: 0.1, memory: 10 * MiB },
    { t: T0 + 15, cpu: 0.2, memory: 20 * MiB },
  ],
  "shop/web-2": [{ t: T0 + 15, cpu: 0.3, memory: 30 * MiB }],
  "data/db-0": [{ t: T0, cpu: 1, memory: 100 * MiB }],
};

test("sumHistory sums the samples of the asked items per timestamp, oldest first", () => {
  expect(sumHistory(HISTORY, ["shop/web-2", "shop/web-1"])).toEqual({
    cpu: [
      [T0, 0.1],
      [T0 + 15, 0.5],
    ],
    memory: [
      [T0, 10 * MiB],
      [T0 + 15, 50 * MiB],
    ],
  });
});

test("sumHistory with null takes every item; unknown and repeated keys add nothing", () => {
  expect(sumHistory(HISTORY, null).cpu).toEqual([
    [T0, 1.1],
    [T0 + 15, 0.5],
  ]);
  expect(sumHistory(HISTORY, ["shop/gone"])).toEqual({ cpu: [], memory: [] });
  expect(sumHistory(HISTORY, ["data/db-0", "data/db-0"]).cpu).toEqual([
    [T0, 1],
  ]);
});

test("a rolling chart spans its samples and at least a minute", () => {
  expect(rollingMinutes([])).toBe(0);
  expect(rollingMinutes([[T0, 1]])).toBe(1);
  expect(
    rollingMinutes([
      [T0, 1],
      [T0 + 61, 1],
    ]),
  ).toBe(2);
  expect(rollingDomain([])).toEqual({ start: 0, end: 60, step: 15 });
  expect(rollingDomain([[T0, 1]])).toEqual({
    start: T0 - 60,
    end: T0,
    step: 15,
  });
  expect(
    rollingDomain([
      [T0, 1],
      [T0 + 900, 1],
    ]),
  ).toEqual({ start: T0, end: T0 + 900, step: 15 });
});

test("the live text counts minutes and samples", () => {
  expect(liveText([])).toBe("Waiting for the first sample");
  expect(liveText([[T0, 1]])).toBe("Last 1 min, 1 sample");
  const quarter: [number, number][] = Array.from({ length: 61 }, (_, i) => [
    T0 + i * 15,
    1,
  ]);
  expect(liveText(quarter)).toBe("Last 15 min, 61 samples");
});

function pod(
  name: string,
  namespace: string,
  labels: Record<string, string>,
): KubeObject {
  return { metadata: { name, namespace, labels } };
}

function deployment(selector: unknown): KubeObject {
  return {
    metadata: { name: "web", namespace: "shop" },
    spec: { selector },
  };
}

test("workloadPods matches matchExpressions alone, ignores other namespaces, and an empty selector matches no Pod", () => {
  const pods = [
    pod("web-1", "shop", { app: "web", tier: "front" }),
    pod("web-2", "shop", { app: "web", tier: "canary" }),
    pod("web-3", "data", { app: "web", tier: "front" }),
    pod("api-1", "shop", { app: "api" }),
  ];
  const names = (workload: KubeObject) =>
    workloadPods(workload, pods).map((p) => p.metadata.name);

  expect(
    names(
      deployment({
        matchExpressions: [
          { key: "app", operator: "In", values: ["web"] },
          { key: "tier", operator: "NotIn", values: ["canary"] },
        ],
      }),
    ),
  ).toEqual(["web-1"]);
  expect(
    names(
      deployment({
        matchLabels: { app: "web" },
        matchExpressions: [{ key: "tier", operator: "Exists" }],
      }),
    ),
  ).toEqual(["web-1", "web-2"]);
  expect(
    names(
      deployment({
        matchExpressions: [{ key: "tier", operator: "DoesNotExist" }],
      }),
    ),
  ).toEqual(["api-1"]);
  expect(names(deployment({}))).toEqual([]);
  expect(names(deployment({ matchLabels: {}, matchExpressions: [] }))).toEqual(
    [],
  );
  expect(names(deployment(undefined))).toEqual([]);
  expect(names({ metadata: { name: "web", namespace: "shop" } })).toEqual([]);
});
