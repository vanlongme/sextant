import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../objects";
import { kindSpec } from "../registry";
import {
  conditionStatus,
  gatewayAddress,
  routeHostnames,
  routeParents,
} from "./gateway";
import "./index";

const GROUP = "gateway.networking.k8s.io";

function obj(over: Partial<KubeObject> = {}): KubeObject {
  return { metadata: { name: "edge", namespace: "web" }, ...over };
}

function info(plural: string, kind: string, namespaced: boolean) {
  return {
    resource: { group: GROUP, version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  } satisfies ApiResourceInfo;
}

const columns = (plural: string, kind: string, namespaced: boolean) =>
  kindSpec(GROUP, plural)?.columns?.(info(plural, kind, namespaced)) ?? [];

function cell(
  plural: string,
  kind: string,
  namespaced: boolean,
  id: string,
  o: KubeObject,
) {
  const column = columns(plural, kind, namespaced).find((c) => c.id === id);
  render(<div data-testid="cell">{column?.render(o)}</div>);
  return screen.getByTestId("cell");
}

describe("conditionStatus", () => {
  it("reads True, False and Unknown, and nothing for a missing condition", () => {
    const withStatus = (status: string) =>
      obj({ status: { conditions: [{ type: "Programmed", status }] } });
    expect(conditionStatus(withStatus("True"), "Programmed")).toEqual({
      label: "True",
      tone: "ok",
    });
    expect(conditionStatus(withStatus("False"), "Programmed")).toEqual({
      label: "False",
      tone: "danger",
    });
    expect(conditionStatus(withStatus("Unknown"), "Programmed")).toEqual({
      label: "Unknown",
      tone: "neutral",
    });
    expect(conditionStatus(withStatus("True"), "Accepted")).toBeNull();
    expect(conditionStatus(obj(), "Accepted")).toBeNull();
  });
});

describe("gatewayAddress", () => {
  it("shows the first address, then +N for the rest, or a dash", () => {
    expect(gatewayAddress(obj())).toBe("—");
    expect(
      gatewayAddress(obj({ status: { addresses: [{ value: "10.0.0.5" }] } })),
    ).toBe("10.0.0.5");
    expect(
      gatewayAddress(
        obj({
          status: {
            addresses: [
              { value: "10.0.0.5" },
              { value: "10.0.0.6" },
              { value: "10.0.0.7" },
            ],
          },
        }),
      ),
    ).toBe("10.0.0.5 +2");
  });
});

describe("routeHostnames and routeParents", () => {
  it("join the hostnames, or a dash", () => {
    expect(routeHostnames(obj())).toBe("—");
    expect(routeHostnames(obj({ spec: { hostnames: ["shop", "api"] } }))).toBe(
      "shop, api",
    );
  });

  it("name each parent with the route's namespace when it gives none", () => {
    expect(routeParents(obj())).toBe("—");
    expect(
      routeParents(
        obj({
          spec: {
            parentRefs: [
              { name: "edge" },
              { name: "shared", namespace: "infra" },
            ],
          },
        }),
      ),
    ).toBe("web/edge, infra/shared");
  });
});

describe("the Gateway API columns", () => {
  it("follow the spec's table after Name and Namespace", () => {
    const headers = (plural: string, kind: string, namespaced: boolean) =>
      columns(plural, kind, namespaced).map((c) => c.header);
    expect(headers("gatewayclasses", "GatewayClass", false)).toEqual([
      "Name",
      "Controller",
      "Accepted",
      "Age",
    ]);
    expect(headers("gateways", "Gateway", true)).toEqual([
      "Name",
      "Namespace",
      "Class",
      "Address",
      "Programmed",
      "Age",
    ]);
    expect(headers("httproutes", "HTTPRoute", true)).toEqual([
      "Name",
      "Namespace",
      "Hostnames",
      "Parents",
      "Age",
    ]);
  });

  it("show a condition in a Badge, and a dash without it", () => {
    const programmed = cell(
      "gateways",
      "Gateway",
      true,
      "programmed",
      obj({
        status: { conditions: [{ type: "Programmed", status: "False" }] },
      }),
    );
    expect(programmed.textContent).toBe("False");
    expect(programmed.querySelector(".danger")).toBeTruthy();
  });

  it("show a dash for a class with no Accepted condition", () => {
    expect(
      cell("gatewayclasses", "GatewayClass", false, "accepted", obj())
        .textContent,
    ).toBe("—");
  });

  it("show the class name", () => {
    expect(
      cell(
        "gateways",
        "Gateway",
        true,
        "class",
        obj({ spec: { gatewayClassName: "shared" } }),
      ).textContent,
    ).toBe("shared");
  });
});
