import { Star } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { mockBackend } from "../../test/ipc";
import { type ActionContext, kindSpec } from "../registry";
import { setDefaultAction } from "./actions";
import "./index";

afterEach(() => vi.restoreAllMocks());

const INGRESS_CLASSES: ResourceRef = {
  group: "networking.k8s.io",
  version: "v1",
  plural: "ingressclasses",
  kind: "IngressClass",
  namespaced: false,
};

const context: ActionContext = {
  clusterId: "c",
  resource: INGRESS_CLASSES,
  navigate: () => {},
  confirm: async () => true,
  openEditor: () => {},
  dialog: () => {},
};

const KEY = "ingressclass.kubernetes.io/is-default-class";
const cls = (name: string, annotations?: Record<string, string>) => ({
  metadata: { name, annotations },
});

test("Set as default is offered only for a class that is not the default", () => {
  expect(setDefaultAction.visible?.(cls("a", { [KEY]: "true" }))).toBe(false);
  expect(setDefaultAction.visible?.(cls("b", { [KEY]: "false" }))).toBe(true);
  expect(setDefaultAction.visible?.(cls("c"))).toBe(true);
  expect(setDefaultAction).toMatchObject({
    id: "set-default",
    label: "Set as default",
    requires: "patch",
  });
  expect(setDefaultAction.icon).toBe(Star);
});

test("Set as default runs at once and says so", async () => {
  const backend = mockBackend({ ingress_class_set_default: () => null });
  const success = vi.spyOn(toast, "success");
  await setDefaultAction.run(context, cls("b"));
  expect(backend.callsTo("ingress_class_set_default")[0]).toMatchObject({
    clusterId: "c",
    name: "b",
  });
  expect(success).toHaveBeenCalledWith("b is now the default IngressClass");
});

test("a partial failure reaches runAction instead of being swallowed", async () => {
  mockBackend({
    ingress_class_set_default: () => {
      throw {
        code: "Conflict",
        message: "a was left unchanged",
        details: null,
      };
    },
  });
  await expect(setDefaultAction.run(context, cls("b"))).rejects.toThrow(
    "a was left unchanged",
  );
});

test("IngressClasses offer Set as default", () => {
  expect(
    kindSpec("networking.k8s.io", "ingressclasses")?.actions?.map((a) => a.id),
  ).toEqual(["set-default"]);
});
