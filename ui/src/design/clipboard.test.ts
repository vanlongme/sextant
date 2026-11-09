import { expect, test } from "vitest";
import { mockBackend } from "../test/ipc";
import { copyText, readClipboardText } from "./clipboard";

test("copyText writes the text through the clipboard plugin", async () => {
  const backend = mockBackend({
    "plugin:clipboard-manager|write_text": () => null,
  });
  await copyText("u-123");
  expect(
    backend.callsTo("plugin:clipboard-manager|write_text")[0],
  ).toMatchObject({ text: "u-123" });
});

test("a refused write rejects", async () => {
  mockBackend({});
  await expect(copyText("u-123")).rejects.toBeDefined();
});

test("readClipboardText reads the text through the clipboard plugin", async () => {
  mockBackend({ "plugin:clipboard-manager|read_text": () => "pasted text" });
  await expect(readClipboardText()).resolves.toBe("pasted text");
});

test("a refused read rejects", async () => {
  mockBackend({});
  await expect(readClipboardText()).rejects.toBeDefined();
});
