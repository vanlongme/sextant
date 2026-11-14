import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { DrawerLinkContext, objectTarget, targetKey } from "./links";
import { ObjectLink } from "./parts";

function served(
  group: string,
  plural: string,
  kind: string,
  namespaced: boolean,
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

const RESOURCES = [
  served("", "nodes", "Node", false),
  served("", "configmaps", "ConfigMap", true),
  served("apps", "replicasets", "ReplicaSet", true),
  served("example.com", "replicasets", "ReplicaSet", true),
];

const link = (open?: (t: unknown) => void, label?: string, testId?: string) =>
  render(
    <MemoryRouter>
      {open ? (
        <DrawerLinkContext.Provider value={{ open }}>
          <ObjectLink
            clusterId="c1"
            resources={RESOURCES}
            kind="ConfigMap"
            name="app-config"
            namespace="n"
            apiVersion="v1"
            label={label}
            testId={testId}
          />
        </DrawerLinkContext.Provider>
      ) : (
        <ObjectLink
          clusterId="c1"
          resources={RESOURCES}
          kind="ConfigMap"
          name="app-config"
          namespace="n"
          apiVersion="v1"
        />
      )}
    </MemoryRouter>,
  );

test("targetKey joins group, plural, namespace and name", () => {
  expect(
    targetKey({ group: "", plural: "configmaps", namespace: "n", name: "c" }),
  ).toBe("/configmaps/n/c");
  expect(
    targetKey({ group: "", plural: "nodes", namespace: null, name: "n1" }),
  ).toBe("/nodes//n1");
});

test("objectTarget finds the served kind, by apiVersion when given, and drops a cluster-scoped namespace", () => {
  expect(
    objectTarget(
      { kind: "ReplicaSet", name: "r", apiVersion: "example.com/v1" },
      "n",
      RESOURCES,
    ),
  ).toEqual({
    group: "example.com",
    plural: "replicasets",
    namespace: "n",
    name: "r",
  });
  expect(
    objectTarget({ kind: "ReplicaSet", name: "r" }, "n", RESOURCES)?.group,
  ).toBe("apps");
  expect(
    objectTarget(
      { kind: "Node", name: "n1", apiVersion: "v1" },
      "n",
      RESOURCES,
    ),
  ).toEqual({ group: "", plural: "nodes", namespace: null, name: "n1" });
  expect(
    objectTarget({ kind: "Gadget", name: "g" }, "n", RESOURCES),
  ).toBeNull();
});

test("inside a drawer an ObjectLink is a button that opens its target", () => {
  const open = vi.fn();
  link(open);
  const button = screen.getByTestId("detail-link");
  expect(button.tagName).toBe("BUTTON");
  expect(button.getAttribute("type")).toBe("button");
  expect(button.getAttribute("data-target")).toBe("/configmaps/n/app-config");
  expect(button.getAttribute("title")).toBe("Open ConfigMap app-config");
  expect(button.textContent).toBe("ConfigMap app-config");
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith({
    group: "",
    plural: "configmaps",
    namespace: "n",
    name: "app-config",
  });
});

test("a testId and a label name the button", () => {
  link(vi.fn(), "app-config", "detail-owner-link");
  expect(screen.getByTestId("detail-owner-link").textContent).toBe(
    "app-config",
  );
});

test("outside a drawer it links to the object's list", () => {
  link();
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "/cluster/c1/r/core/configmaps?object=n%2Fapp-config",
  );
});

test("a kind the cluster does not serve is plain text, in a drawer or not", () => {
  render(
    <MemoryRouter>
      <DrawerLinkContext.Provider value={{ open: vi.fn() }}>
        <ObjectLink clusterId="c1" resources={[]} kind="Gadget" name="g" />
      </DrawerLinkContext.Provider>
      <ObjectLink clusterId="c1" resources={[]} kind="Gadget" name="h" />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(document.body.textContent).toContain("Gadget g");
  expect(document.body.textContent).toContain("Gadget h");
});
