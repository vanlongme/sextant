import { expect, test } from "vitest";
import { emitEvent, mockBackend } from "../test/ipc";
import { events } from "./events";
import type { ToolProgress } from "./generated/ToolProgress";

const PROGRESS: ToolProgress = {
  tool: "helm",
  phase: "downloading",
  receivedBytes: 1024,
  totalBytes: 4096,
  error: null,
};

test("onToolsProgress hands each tools://progress payload over until it is unlistened", async () => {
  mockBackend({});
  const seen: ToolProgress[] = [];
  const unlisten = await events.onToolsProgress((p) => seen.push(p));

  await emitEvent("tools://progress", PROGRESS);
  unlisten();
  await emitEvent("tools://progress", { ...PROGRESS, phase: "done" });

  expect(seen).toEqual([PROGRESS]);
});
