import { expect, test } from "vitest";
import {
  affinitySummary,
  affinityTerms,
  conditionChips,
  expressionText,
  nodeSelectorEntries,
  tolerationRow,
  tolerationSummary,
  tolerationsOf,
} from "./scheduling";

test("node selector entries read k=v", () => {
  expect(
    nodeSelectorEntries({ nodeSelector: { disk: "ssd", zone: "a" } }),
  ).toEqual(["disk=ssd", "zone=a"]);
  expect(nodeSelectorEntries({})).toEqual([]);
});

test("tolerations summarise their distinct effects and a shared delay", () => {
  const list = tolerationsOf({
    tolerations: [
      {
        key: "node.kubernetes.io/not-ready",
        operator: "Exists",
        effect: "NoExecute",
        tolerationSeconds: 300,
      },
      {
        key: "node.kubernetes.io/unreachable",
        operator: "Exists",
        effect: "NoExecute",
        tolerationSeconds: 300,
      },
    ],
  });
  expect(tolerationSummary(list)).toBe("NoExecute after 300s");
  expect(
    tolerationSummary([
      { effect: "NoSchedule" },
      { operator: "Exists" },
      { effect: "NoExecute", tolerationSeconds: 5 },
    ]),
  ).toBe("NoSchedule, All, NoExecute");
  expect(tolerationsOf({})).toEqual([]);
});

test("a toleration row fills the defaults", () => {
  expect(tolerationRow({})).toEqual(["—", "Equal", "—", "All"]);
  expect(
    tolerationRow({
      key: "k",
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 300,
    }),
  ).toEqual(["k", "Exists", "—", "NoExecute 300s"]);
  expect(tolerationRow({ key: "k", value: "v", effect: "NoSchedule" })).toEqual(
    ["k", "Equal", "v", "NoSchedule"],
  );
});

test("expressions read in their operator's form", () => {
  expect(
    expressionText({ key: "zone", operator: "In", values: ["a", "b"] }),
  ).toBe("zone In (a, b)");
  expect(
    expressionText({ key: "zone", operator: "NotIn", values: ["a"] }),
  ).toBe("zone NotIn (a)");
  expect(expressionText({ key: "gpu", operator: "Exists" })).toBe("gpu Exists");
  expect(expressionText({ key: "gpu", operator: "DoesNotExist" })).toBe(
    "gpu DoesNotExist",
  );
  expect(expressionText({ key: "cores", operator: "Gt", values: ["3"] })).toBe(
    "cores Gt 3",
  );
  expect(expressionText({ key: "cores", operator: "Lt", values: ["3"] })).toBe(
    "cores Lt 3",
  );
});

test("affinity terms give their type, when, match and topology", () => {
  const terms = affinityTerms({
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: "zone", operator: "In", values: ["a", "b"] },
            ],
            matchFields: [
              { key: "metadata.name", operator: "NotIn", values: ["n9"] },
            ],
          },
          {},
        ],
      },
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          weight: 10,
          preference: {
            matchExpressions: [{ key: "disk", operator: "Exists" }],
          },
        },
      ],
    },
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: { matchLabels: { app: "db" } },
          namespaces: ["data", "shared"],
          topologyKey: "kubernetes.io/hostname",
        },
      ],
    },
    podAntiAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          weight: 100,
          podAffinityTerm: {
            labelSelector: {
              matchLabels: { app: "web" },
              matchExpressions: [
                { key: "tier", operator: "NotIn", values: ["batch"] },
              ],
            },
            topologyKey: "topology.kubernetes.io/zone",
          },
        },
        {
          weight: 1,
          podAffinityTerm: {
            labelSelector: {},
            topologyKey: "kubernetes.io/hostname",
          },
        },
      ],
    },
  });
  expect(terms).toEqual([
    {
      type: "Node affinity",
      when: "required during scheduling",
      match: "zone In (a, b) and metadata.name NotIn (n9)",
      topology: null,
    },
    {
      type: "Node affinity",
      when: "required during scheduling",
      match: "all Nodes",
      topology: null,
    },
    {
      type: "Node affinity",
      when: "preferred, weight 10",
      match: "disk Exists",
      topology: null,
    },
    {
      type: "Pod affinity",
      when: "required during scheduling",
      match: "app=db in data, shared",
      topology: "kubernetes.io/hostname",
    },
    {
      type: "Pod anti-affinity",
      when: "preferred, weight 100",
      match: "app=web and tier NotIn (batch)",
      topology: "topology.kubernetes.io/zone",
    },
    {
      type: "Pod anti-affinity",
      when: "preferred, weight 1",
      match: "all Pods",
      topology: "kubernetes.io/hostname",
    },
  ]);
  expect(affinitySummary(terms)).toBe(
    "Node affinity, Pod affinity, Pod anti-affinity",
  );
  expect(affinityTerms(undefined)).toEqual([]);
});

test("condition chips carry their tone and tooltip", () => {
  expect(
    conditionChips({
      conditions: [
        { type: "Ready", status: "True" },
        {
          type: "ContainersReady",
          status: "False",
          reason: "ContainersNotReady",
        },
        { type: "PodScheduled", status: "False" },
        { type: "Odd", status: "Unknown" },
      ],
    }),
  ).toEqual([
    { type: "Ready", tone: "ok", title: "Ready: True" },
    {
      type: "ContainersReady",
      tone: "warn",
      title: "ContainersReady: False (ContainersNotReady)",
    },
    { type: "PodScheduled", tone: "warn", title: "PodScheduled: False" },
    { type: "Odd", tone: "neutral", title: "Odd: Unknown" },
  ]);
  expect(conditionChips(undefined)).toEqual([]);
});
