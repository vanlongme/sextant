import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../objects";
import {
  RoleBindingDetail,
  RoleDetail,
  ServiceAccountDetail,
} from "./AccessDetails";

const ref = (
  group: string,
  plural: string,
  kind: string,
  namespaced: boolean,
): ResourceRef => ({ group, version: "v1", plural, kind, namespaced });
const info = (r: ResourceRef) =>
  ({ resource: r }) as unknown as ApiResourceInfo;

const RBAC = "rbac.authorization.k8s.io";
const RESOURCES = [
  info(ref(RBAC, "roles", "Role", true)),
  info(ref(RBAC, "clusterroles", "ClusterRole", false)),
  info(ref("", "serviceaccounts", "ServiceAccount", true)),
  info(ref("", "secrets", "Secret", true)),
];

function show(Detail: typeof RoleDetail, object: KubeObject) {
  render(
    <MemoryRouter>
      <Detail
        clusterId="c"
        object={object}
        resource={ref(RBAC, "roles", "Role", true)}
        resources={RESOURCES}
      />
    </MemoryRouter>,
  );
}

const href = (name: string) =>
  decodeURIComponent(
    screen.getByRole("link", { name }).getAttribute("href") ?? "",
  );

test("a role shows its rules, with the core group as core", () => {
  show(RoleDetail, {
    metadata: { name: "r", namespace: "d" },
    rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
  });
  const table = within(screen.getByTestId("detail-rules"));
  expect(table.getByText("core")).toBeTruthy();
  expect(table.getByText("pods")).toBeTruthy();
});

test("a binding to a ClusterRole links to the ClusterRole without a namespace", () => {
  show(RoleBindingDetail, {
    metadata: { name: "b", namespace: "d" },
    roleRef: { kind: "ClusterRole", name: "admin" },
    subjects: [
      { kind: "ServiceAccount", name: "sa", namespace: "other" },
      { kind: "User", name: "alice" },
    ],
  });
  const role = href("ClusterRole admin");
  expect(role).toContain("/clusterroles?");
  expect(role).toContain("object=/admin");
  expect(href("ServiceAccount sa")).toContain("object=other/sa");
  expect(screen.getByText("alice")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /alice/ })).toBeNull();
});

test("a binding to a Role links within its namespace", () => {
  show(RoleBindingDetail, {
    metadata: { name: "b", namespace: "d" },
    roleRef: { kind: "Role", name: "admin" },
  });
  const role = href("Role admin");
  expect(role).toContain("/roles?");
  expect(role).toContain("object=d/admin");
});

test("a service account shows its secrets and token setting", () => {
  show(ServiceAccountDetail, {
    metadata: { name: "sa", namespace: "d" },
    secrets: [{ name: "tok" }],
    imagePullSecrets: [{ name: "pull" }],
    automountServiceAccountToken: false,
  });
  expect(screen.getByRole("link", { name: "Secret tok" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Secret pull" })).toBeTruthy();
  expect(screen.getByText("false")).toBeTruthy();
});
