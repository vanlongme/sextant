import { Circle } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../../kinds/objects";
import { CONFIGMAPS, NODES } from "../../kinds/refs";
import type { ActionContext, KindAction } from "../../kinds/registry";
import { flush, mockBackend } from "../../test/ipc";
import { forceFinalizeAction, objectActions } from "./objectActions";

afterEach(() => vi.restoreAllMocks());

function info(over: Partial<ApiResourceInfo> = {}): ApiResourceInfo {
  return {
    resource: CONFIGMAPS,
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
    ...over,
  };
}

function context(over: Partial<ActionContext> = {}): ActionContext {
  return {
    clusterId: "c",
    resource: CONFIGMAPS,
    navigate: () => {},
    confirm: async () => true,
    openEditor: () => {},
    dialog: () => {},
    ...over,
  };
}

const action = (id: string, over: Partial<KindAction> = {}): KindAction => ({
  id,
  label: id,
  icon: Circle,
  run: () => {},
  ...over,
});

const LIVE: KubeObject = { metadata: { name: "cfg", namespace: "n" } };
const DELETING: KubeObject = {
  metadata: {
    name: "cfg",
    namespace: "n",
    deletionTimestamp: "2026-11-08T10:00:00Z",
  },
};

function items(over: Partial<Parameters<typeof objectActions>[0]> = {}) {
  return objectActions({
    object: LIVE,
    kindActions: [],
    info: info(),
    context: context(),
    onDelete: () => {},
    ...over,
  });
}

const ids = (list: { id: string }[]) => list.map((i) => i.id);

test("Edit YAML comes first, then the kind's actions, Force finalize, end actions and Delete", () => {
  const list = items({
    object: DELETING,
    kindActions: [
      action("late", { placement: "end" }),
      action("first"),
      action("second"),
    ],
  });
  expect(ids(list)).toEqual([
    "edit",
    "first",
    "second",
    "force-finalize",
    "late",
    "delete",
  ]);
});

test("Force finalize is offered only while the object is being deleted", () => {
  expect(ids(items({ object: LIVE }))).not.toContain("force-finalize");
  const finalize = items({ object: DELETING }).find(
    (i) => i.id === "force-finalize",
  );
  expect(finalize).toMatchObject({ label: "Force finalize", danger: true });
});

test("an action its visible rule hides is left out", () => {
  const list = items({
    kindActions: [
      action("hidden", { visible: () => false }),
      action("shown", { visible: (o) => o.metadata.name === "cfg" }),
    ],
  });
  expect(ids(list)).toEqual(["edit", "shown", "delete"]);
});

test.each([
  ["update", "canUpdate"],
  ["patch", "canPatch"],
  ["delete", "canDelete"],
] as const)(
  "an action that needs %s is disabled without %s",
  (requires, flag) => {
    const find = (allowed: boolean) =>
      items({
        kindActions: [action("x", { requires })],
        info: info({ [flag]: allowed }),
      }).find((i) => i.id === "x");
    expect(find(false)?.disabled).toBe(true);
    expect(find(true)?.disabled).toBe(false);
  },
);

test("Force finalize needs patch access", () => {
  const finalize = items({
    object: DELETING,
    info: info({ canPatch: false }),
  }).find((i) => i.id === "force-finalize");
  expect(finalize?.disabled).toBe(true);
});

test("Delete needs delete access and hands the object to onDelete", () => {
  const onDelete = vi.fn();
  const del = (canDelete: boolean) =>
    items({ info: info({ canDelete }), onDelete }).find(
      (i) => i.id === "delete",
    );
  expect(del(false)?.disabled).toBe(true);
  const item = del(true);
  expect(item).toMatchObject({
    label: "Delete",
    danger: true,
    disabled: false,
    top: false,
  });
  item?.run();
  expect(onDelete).toHaveBeenCalledWith(LIVE);
});

test("Edit YAML is a top item that opens the editor, and top is carried through", () => {
  const openEditor = vi.fn();
  const list = items({
    context: context({ openEditor }),
    kindActions: [action("pinned", { top: true }), action("plain")],
  });
  expect(list.filter((i) => i.top).map((i) => i.id)).toEqual([
    "edit",
    "pinned",
  ]);
  const edit = list[0];
  expect(edit).toMatchObject({
    label: "Edit YAML",
    danger: false,
    disabled: false,
  });
  edit.run();
  expect(openEditor).toHaveBeenCalledWith(LIVE);
});

test("each item carries its action's icon", () => {
  const [, item] = items({ kindActions: [action("x")] });
  expect(item.icon).toBe(Circle);
});

test("a failed action shows '<label> failed' with the server's message", async () => {
  const error = vi.spyOn(toast, "error");
  const [, item] = items({
    kindActions: [
      action("boom", {
        label: "Boom",
        run: () => Promise.reject(new Error("it broke")),
      }),
    ],
  });
  item.run();
  await flush();
  expect(error).toHaveBeenCalledWith("Boom failed", "it broke");
});

test("Force finalize asks first, removes the finalizers and says so", async () => {
  const backend = mockBackend({ resource_force_finalize: () => null });
  const success = vi.spyOn(toast, "success");
  const asked: Parameters<ActionContext["confirm"]>[0][] = [];
  await forceFinalizeAction.run(
    context({
      confirm: async (o) => {
        asked.push(o);
        return true;
      },
    }),
    DELETING,
  );
  expect(asked).toEqual([
    {
      title: "Force finalize ConfigMap cfg?",
      body: "This removes every finalizer, so the object goes now. Controllers waiting on them will not clean up what they own.",
      confirmLabel: "Force finalize",
      danger: true,
    },
  ]);
  const calls = backend.callsTo("resource_force_finalize");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    clusterId: "c",
    resource: CONFIGMAPS,
    namespace: "n",
    name: "cfg",
  });
  expect(success).toHaveBeenCalledWith("Removed the finalizers of cfg");
});

test("a cluster-scoped object is finalized with a null namespace", async () => {
  const backend = mockBackend({ resource_force_finalize: () => null });
  await forceFinalizeAction.run(context({ resource: NODES }), {
    metadata: { name: "n1", deletionTimestamp: "2026-11-08T10:00:00Z" },
  });
  expect(backend.callsTo("resource_force_finalize")[0]).toMatchObject({
    resource: NODES,
    namespace: null,
    name: "n1",
  });
});

test("Force finalize does nothing when the answer is no", async () => {
  const backend = mockBackend({ resource_force_finalize: () => null });
  await forceFinalizeAction.run(
    context({ confirm: async () => false }),
    DELETING,
  );
  expect(backend.callsTo("resource_force_finalize")).toHaveLength(0);
});
