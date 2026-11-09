import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { PODS } from "../../kinds/refs";
import { logsTab } from "../../stores/dock";
import { flush, mockBackend } from "../../test/ipc";
import { formatSize, useLogDownload } from "./logDownload";

const TAB = logsTab("c1", PODS, {
  metadata: { name: "web-1", namespace: "shop" },
  spec: { containers: [{ name: "app" }] },
});

test.each<[number, string]>([
  [0, "0 B"],
  [1023, "1,023 B"],
  [1024, "1.0 KiB"],
  [1536, "1.5 KiB"],
  [1024 ** 2, "1.0 MiB"],
  [5 * 1024 ** 3, "5.0 GiB"],
  [3072 * 1024 ** 3, "3,072.0 GiB"],
])("%i bytes read %s", (bytes, text) => {
  expect(formatSize(bytes)).toBe(text);
});

test("a second press before the dialog answers asks once and writes once", async () => {
  const b = mockBackend({
    "plugin:dialog|save": () => "/home/me/web-1.log",
    // Never answers: the download is still running.
    logs_download: () => new Promise(() => {}),
  });
  const { result } = renderHook(() => useLogDownload(TAB));

  await act(async () => {
    void result.current.download();
    void result.current.download();
    await flush();
  });
  expect(b.callsTo("plugin:dialog|save")).toHaveLength(1);
  expect(b.callsTo("logs_download")).toHaveLength(1);
  expect(result.current.saving).toBe(true);

  await act(async () => {
    void result.current.download();
    await flush();
  });
  expect(b.callsTo("plugin:dialog|save")).toHaveLength(1);
});

test("a dialog that fails is reported, and download works again", async () => {
  const b = mockBackend({
    "plugin:dialog|save": () => {
      throw "dialog unavailable";
    },
  });
  const { result } = renderHook(() => useLogDownload(TAB));

  await act(() => result.current.download());
  expect(result.current.note).toEqual({
    text: "Could not download the logs: dialog unavailable",
    failed: true,
  });
  expect(result.current.saving).toBe(false);

  await act(() => result.current.download());
  expect(b.callsTo("plugin:dialog|save")).toHaveLength(2);
});
