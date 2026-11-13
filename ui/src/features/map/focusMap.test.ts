import { describe, expect, it } from "vitest";
import { focusNamespaces, idParts, parseDepth } from "./focusMap";

describe("idParts", () => {
  it("splits a node id into kind, namespace and name", () => {
    expect(idParts("Pod/shop/web-1")).toEqual({
      kind: "Pod",
      namespace: "shop",
      name: "web-1",
    });
    expect(idParts("GatewayClass//shared")).toEqual({
      kind: "GatewayClass",
      namespace: "",
      name: "shared",
    });
    expect(idParts("LoadBalancer//203.0.113.24")).toEqual({
      kind: "LoadBalancer",
      namespace: "",
      name: "203.0.113.24",
    });
  });

  it("keeps an id without slashes as the name", () => {
    expect(idParts("web")).toEqual({ kind: "", namespace: "", name: "web" });
  });
});

describe("focusNamespaces", () => {
  it("is the focus's namespace, or every namespace outside one", () => {
    expect(focusNamespaces("Deployment/shop/web")).toEqual(["shop"]);
    expect(focusNamespaces("LoadBalancer//10.0.0.5")).toBeNull();
    expect(focusNamespaces("GatewayClass//shared")).toBeNull();
  });
});

describe("parseDepth", () => {
  it("reads 1, 2 and all, and 2 for anything else", () => {
    expect(parseDepth("1")).toBe(1);
    expect(parseDepth("2")).toBe(2);
    expect(parseDepth("all")).toBe("all");
    expect(parseDepth(null)).toBe(2);
    expect(parseDepth("3")).toBe(2);
  });
});
