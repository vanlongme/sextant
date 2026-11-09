import { Zap } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { mockBackend } from "../../test/ipc";
import { PODS } from "../refs";
import { type ActionContext, kindSpec } from "../registry";
import "./index";
import { forceDeleteAction } from "./podActions";

afterEach(() => vi.restoreAllMocks());

function context(answer: boolean, asked: unknown[] = []): ActionContext {
  return {
    clusterId: "c",
    resource: PODS,
    navigate: () => {},
    confirm: async (o) => {
      asked.push(o);
      return answer;
    },
    openEditor: () => {},
    dialog: () => {},
  };
}

const POD = { metadata: { name: "web-1", namespace: "n", uid: "u-old" } };

test("force delete sits just before Delete, needs delete access and is dangerous", () => {
  expect(forceDeleteAction).toMatchObject({
    id: "force-delete",
    label: "Force delete",
    placement: "end",
    requires: "delete",
    danger: true,
  });
  expect(forceDeleteAction.icon).toBe(Zap);
});

test("force delete asks first and names the Pod by its uid", async () => {
  const backend = mockBackend({ pod_force_delete: () => null });
  const success = vi.spyOn(toast, "success");
  const asked: unknown[] = [];
  await forceDeleteAction.run(context(true, asked), POD);
  expect(asked).toEqual([
    {
      title: "Force delete Pod web-1?",
      body: "The Pod is removed at once, without waiting for its containers to stop. The node may keep running them until it notices.",
      confirmLabel: "Force delete",
      danger: true,
    },
  ]);
  expect(backend.callsTo("pod_force_delete")[0]).toMatchObject({
    clusterId: "c",
    namespace: "n",
    name: "web-1",
    uid: "u-old",
  });
  expect(success).toHaveBeenCalledWith("Force deleted web-1");
});

test("force delete does nothing when the answer is no", async () => {
  const backend = mockBackend({ pod_force_delete: () => null });
  await forceDeleteAction.run(context(false), POD);
  expect(backend.callsTo("pod_force_delete")).toHaveLength(0);
});

test("Pods offer Logs, Shell, Attach, Evict and Force delete", () => {
  expect(kindSpec("", "pods")?.actions?.map((a) => a.id)).toEqual([
    "logs",
    "shell",
    "attach",
    "evict",
    "force-delete",
  ]);
});
