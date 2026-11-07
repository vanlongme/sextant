import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { flush } from "../../test/ipc";
import { YamlEditor } from "./YamlEditor";

const state = vi.hoisted(() => ({
  editors: [] as FakeEditor[],
  fail: false,
}));

class FakeEditor {
  value: string;
  options: Record<string, unknown>;
  listener: (() => void) | null = null;
  disposed = false;
  modelDisposed = false;

  constructor(options: Record<string, unknown>) {
    this.value = String(options.value);
    this.options = options;
  }
  getValue() {
    return this.value;
  }
  setValue(next: string) {
    this.value = next;
    this.listener?.();
  }
  type(next: string) {
    this.value = next;
    this.listener?.();
  }
  updateOptions(options: Record<string, unknown>) {
    this.options = { ...this.options, ...options };
  }
  onDidChangeModelContent(listener: () => void) {
    this.listener = listener;
    return { dispose: () => (this.listener = null) };
  }
  getModel() {
    return { dispose: () => (this.modelDisposed = true) };
  }
  dispose() {
    this.disposed = true;
  }
}

vi.mock("./monaco", () => ({
  get monaco() {
    if (state.fail) throw new Error("chunk failed");
    return {
      editor: {
        create: (_: HTMLElement, options: Record<string, unknown>) => {
          const editor = new FakeEditor(options);
          state.editors.push(editor);
          return editor;
        },
      },
    };
  },
  currentTheme: () => "skopos-dark",
}));

beforeEach(() => {
  state.editors.length = 0;
  state.fail = false;
});

async function mounted(value = "a: 1\n") {
  const onChange = vi.fn();
  const view = render(
    <YamlEditor value={value} onChange={onChange} testId="editor" />,
  );
  await act(flush);
  return { onChange, view, editor: state.editors[0] };
}

test("creates a YAML editor with the value and the test id", async () => {
  const { editor } = await mounted();

  expect(screen.getByTestId("editor")).toBeTruthy();
  expect(editor.options).toMatchObject({
    value: "a: 1\n",
    language: "yaml",
    automaticLayout: true,
    readOnly: false,
  });
});

test("typing reports the new text", async () => {
  const { editor, onChange } = await mounted();

  editor.type("b: 2\n");

  expect(onChange).toHaveBeenCalledWith("b: 2\n");
});

test("a new value from outside replaces the text without reporting a change", async () => {
  const { editor, onChange, view } = await mounted();

  view.rerender(
    <YamlEditor value={"c: 3\n"} onChange={onChange} testId="editor" />,
  );

  expect(editor.getValue()).toBe("c: 3\n");
  expect(onChange).not.toHaveBeenCalled();
});

test("readOnly follows the prop", async () => {
  const { editor, onChange, view } = await mounted();

  view.rerender(
    <YamlEditor
      value={"a: 1\n"}
      onChange={onChange}
      readOnly
      testId="editor"
    />,
  );

  expect(editor.options.readOnly).toBe(true);
});

test("going away disposes the editor and its model", async () => {
  const { editor, view } = await mounted();

  view.unmount();

  expect(editor.disposed).toBe(true);
  expect(editor.modelDisposed).toBe(true);
});

test("an editor that cannot load says so", async () => {
  state.fail = true;
  render(<YamlEditor value="" onChange={() => {}} />);
  await act(flush);

  expect(screen.getByRole("alert").textContent).toContain(
    "editor could not be loaded",
  );
});
