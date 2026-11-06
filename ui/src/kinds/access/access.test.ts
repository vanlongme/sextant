import { expect, test } from "vitest";
import { ruleRows, subjectRows, subjectsText } from "./access";

test("rule rows", () => {
  expect(
    ruleRows([
      {
        apiGroups: [""],
        resources: ["pods", "pods/log"],
        verbs: ["get", "list"],
      },
      {
        apiGroups: ["apps"],
        resources: ["deployments"],
        resourceNames: ["web"],
        verbs: ["*"],
      },
      { nonResourceURLs: ["/healthz"], verbs: ["get"] },
    ]),
  ).toEqual([
    {
      groups: "core",
      resources: "pods, pods/log",
      names: "",
      urls: "",
      verbs: "get, list",
    },
    {
      groups: "apps",
      resources: "deployments",
      names: "web",
      urls: "",
      verbs: "*",
    },
    { groups: "", resources: "", names: "", urls: "/healthz", verbs: "get" },
  ]);
  expect(ruleRows(undefined)).toEqual([]);
});

test("subjects", () => {
  const subjects = [
    { kind: "ServiceAccount", name: "a", namespace: "n" },
    { kind: "User", name: "u", apiGroup: "rbac.authorization.k8s.io" },
  ];
  expect(subjectRows(subjects)).toEqual([
    { kind: "ServiceAccount", name: "a", namespace: "n", linkable: true },
    { kind: "User", name: "u", namespace: "", linkable: false },
  ]);
  expect(subjectsText(subjects)).toBe("ServiceAccount n/a, User u");
  expect(subjectsText(undefined)).toBe("");
});
