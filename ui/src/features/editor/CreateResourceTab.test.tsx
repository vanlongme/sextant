import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ApplyResult } from "../../ipc/generated/ApplyResult";
import { resetDockForTest, useDock, writeDraft } from "../../stores/dock";
import { flush, mockBackend } from "../../test/ipc";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import { CreateResourceTab } from "./CreateResourceTab";
import { TEMPLATES } from "./templates";

vi.mock("./YamlEditor", () => ({
  YamlEditor: (props: {
    value: string;
    onChange(v: string): void;
    readOnly?: boolean;
    testId?: string;
  }) => (
    <textarea
      data-testid={props.testId}
      value={props.value}
      readOnly={props.readOnly}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

const TAB = {
  id: "create-tab",
  kind: "create" as const,
  clusterId: "c1",
  title: "Create",
  dirty: false,
};

const DOCUMENT = "kind: ConfigMap\nmetadata:\n  name: app\n";

function backend(
  namespaces: unknown = null,
  apply: () => unknown = () => [] as ApplyResult[],
) {
  return mockBackend({
    ui_state_get: () => namespaces,
    resource_apply: apply,
  });
}

function show() {
  useDock.getState().open(TAB);
  return render(<CreateResourceTab tab={TAB} />);
}

function editor() {
  return screen.getByTestId<HTMLTextAreaElement>("yaml-editor");
}

function applyButton() {
  return screen.getByTestId<HTMLButtonElement>("create-apply");
}

function type(text: string) {
  fireEvent.change(editor(), { target: { value: text } });
}

function dirty() {
  return useDock.getState().tabs.find((t) => t.id === TAB.id)?.dirty;
}

function pickTemplate(id: string) {
  fireEvent.keyDown(screen.getByTestId("create-template"), { key: "Enter" });
  fireEvent.click(screen.getByTestId(`menu-item-${id}`));
}

afterEach(() => resetDockForTest());

test("template fills the editor and leaves it clean", async () => {
  backend();
  show();
  expect(editor().value).toBe("");
  expect(applyButton().disabled).toBe(true);

  pickTemplate("deployment");
  await act(flush);

  const deployment = TEMPLATES.find((t) => t.id === "deployment");
  expect(editor().value).toBe(deployment?.yaml);
  expect(dirty()).toBe(false);
  expect(applyButton().disabled).toBe(false);
});

test("a template asks before replacing unsaved text", async () => {
  backend();
  show();
  type(DOCUMENT);
  expect(dirty()).toBe(true);

  pickTemplate("pod");
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await act(flush);
  expect(editor().value).toBe(DOCUMENT);

  pickTemplate("pod");
  const again = await screen.findByRole("dialog");
  fireEvent.click(within(again).getByRole("button", { name: "Replace" }));
  await act(flush);
  expect(editor().value).toBe(TEMPLATES.find((t) => t.id === "pod")?.yaml);
});

test("per-document results render with ok and failure", async () => {
  const results: ApplyResult[] = [
    {
      index: 0,
      kind: "ConfigMap",
      namespace: "default",
      name: "app",
      ok: true,
      message: "applied",
    },
    {
      index: 1,
      kind: "Widget",
      namespace: null,
      name: "w",
      ok: false,
      message: 'no matches for kind "Widget"',
    },
    {
      index: 2,
      kind: null,
      namespace: null,
      name: null,
      ok: false,
      message: "the document has no kind",
    },
  ];
  backend(null, () => results);
  show();
  type(`${DOCUMENT}---\nkind: Widget\n---\nname: x\n`);

  fireEvent.click(applyButton());
  await act(flush);

  const list = screen.getByTestId("apply-results");
  const ok = within(list).getByTestId("apply-result-0");
  expect(ok.textContent).toContain("ConfigMap");
  expect(ok.textContent).toContain("default/app");
  expect(ok.textContent).toContain("applied");
  expect(ok.dataset.ok).toBe("true");
  const failed = within(list).getByTestId("apply-result-1");
  expect(failed.textContent).toContain('no matches for kind "Widget"');
  expect(failed.dataset.ok).toBe("false");
  expect(within(list).getByTestId("apply-result-2").textContent).toContain(
    "Document 3",
  );

  // Something failed, so the text is still worth keeping.
  expect(editor().value).toContain("Widget");
  expect(dirty()).toBe(true);
});

test("when every document applies the tab is clean", async () => {
  backend(null, () => [
    {
      index: 0,
      kind: "ConfigMap",
      namespace: "default",
      name: "app",
      ok: true,
      message: "applied",
    },
  ]);
  show();
  type(DOCUMENT);
  expect(dirty()).toBe(true);

  fireEvent.click(applyButton());
  await act(flush);

  expect(dirty()).toBe(false);
});

test("the default namespace comes from the first selected namespace filter value", async () => {
  const calls = backend(["team-b", "team-a"]);
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(calls.callsTo("ui_state_get")).toEqual([
    { key: namespaceFilterKey("c1") },
  ]);
  expect(calls.callsTo("resource_apply")).toEqual([
    { clusterId: "c1", yaml: DOCUMENT, defaultNamespace: "team-b" },
  ]);
});

test.each([
  ["no saved filter", null],
  ["the All filter", []],
])("the default namespace is default with %s", async (_, saved) => {
  const calls = backend(saved);
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(calls.callsTo("resource_apply")[0].defaultNamespace).toBe("default");
});

test("the default namespace is default when the filter cannot be read", async () => {
  const calls = mockBackend({
    ui_state_get: () => {
      throw { code: "Internal", message: "no store", details: null };
    },
    resource_apply: () => [],
  });
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(calls.callsTo("resource_apply")[0].defaultNamespace).toBe("default");
});

test("invalid YAML blocks apply", async () => {
  const calls = backend();
  show();

  type("a: 1\nb: 2\n  c: 3\n");

  expect(screen.getByTestId("yaml-error").textContent).toMatch(/line 2/i);
  expect(applyButton().disabled).toBe(true);
  fireEvent.click(applyButton());
  await act(flush);
  expect(calls.callsTo("resource_apply")).toEqual([]);

  type(DOCUMENT);
  expect(screen.queryByTestId("yaml-error")).toBeNull();
  expect(applyButton().disabled).toBe(false);
});

test("text with no documents has nothing to apply", () => {
  backend();
  show();
  type("# just a note\n");
  expect(applyButton().disabled).toBe(true);
  expect(screen.queryByTestId("yaml-error")).toBeNull();
});

test("a request that fails as a whole shows the message and keeps the text", async () => {
  backend(null, () => {
    throw { code: "Unreachable", message: "connection refused", details: null };
  });
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);

  expect(screen.getByTestId("yaml-api-error").textContent).toContain(
    "connection refused",
  );
  expect(editor().value).toBe(DOCUMENT);
  expect(dirty()).toBe(true);
});

test("the editor is read-only while applying", async () => {
  let finish: (v: unknown) => void = () => {};
  backend(null, () => new Promise((resolve) => (finish = resolve)));
  show();
  type(DOCUMENT);

  fireEvent.click(applyButton());
  await act(flush);
  expect(editor().readOnly).toBe(true);

  await act(async () => {
    finish([]);
    await flush();
  });
  expect(editor().readOnly).toBe(false);
});

test("starts from a draft, unsaved, when another tab handed one over", () => {
  backend();
  useDock.getState().open(TAB);
  writeDraft(TAB.id, { text: DOCUMENT, baseline: "", results: [] });

  render(<CreateResourceTab tab={TAB} />);

  expect(editor().value).toBe(DOCUMENT);
  expect(dirty()).toBe(true);
});

test("text and results survive the tab leaving the screen and coming back", async () => {
  backend(null, () => [
    {
      index: 0,
      kind: "ConfigMap",
      namespace: "default",
      name: "app",
      ok: false,
      message: "denied",
    },
  ]);
  const view = show();
  type(DOCUMENT);
  fireEvent.click(applyButton());
  await act(flush);

  view.unmount();
  render(<CreateResourceTab tab={TAB} />);

  expect(editor().value).toBe(DOCUMENT);
  expect(screen.getByTestId("apply-result-0").textContent).toContain("denied");
});
