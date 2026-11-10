import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { ToolStatus } from "../../ipc/generated/ToolStatus";
import { resetHelmForTest } from "../../stores/helm";
import { toolStatus } from "../../test/helm";
import { emitEvent, flush, mockBackend } from "../../test/ipc";
import { ToolsSection } from "./ToolsSection";

beforeEach(() => {
  resetHelmForTest();
  vi.restoreAllMocks();
});

const HELM_MISSING = toolStatus({
  tool: "helm",
  source: "missing",
  path: null,
  version: null,
});
const KUBECTL = toolStatus({ tool: "kubectl", version: "v1.34.1" });

async function show(over: Parameters<typeof mockBackend>[0]) {
  const backend = mockBackend(over);
  render(<ToolsSection />);
  await act(flush);
  return backend;
}

const rowText = (tool: string) =>
  screen.getByTestId(`pref-tool-${tool}`).textContent;

test("shows helm, then kubectl, with a dot and the text of their state", async () => {
  await show({
    tools_status: () => [
      KUBECTL,
      toolStatus({ tool: "helm", source: "managed" }),
    ],
  });
  const rows = screen.getAllByTestId(/^pref-tool-(helm|kubectl)$/);
  expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
    "pref-tool-helm",
    "pref-tool-kubectl",
  ]);
  expect(rowText("helm")).toBe("helm v4.3.1 · managed copy, checksum verified");
  expect(rowText("kubectl")).toBe(
    "kubectl v1.34.1 · found on PATH at /usr/local/bin/kubectl",
  );
  expect(screen.getAllByLabelText("Ready")).toHaveLength(2);
});

test("a missing tool downloads with progress and Cancel, then reads its new state", async () => {
  const success = vi.spyOn(toast, "success");
  let statuses: ToolStatus[] = [HELM_MISSING, KUBECTL];
  let finish: (status: ToolStatus) => void = () => {};
  const backend = await show({
    tools_status: () => statuses,
    tools_download: () =>
      new Promise<ToolStatus>((resolve) => {
        finish = resolve;
      }),
    tools_download_cancel: () => null,
  });
  expect(screen.getByLabelText("Not available")).toBeTruthy();
  fireEvent.click(screen.getByTestId("pref-tool-download-helm"));
  await act(flush);
  expect(rowText("helm")).toContain("Downloading helm v4.3.1 · 0.0 MB");

  await emitEvent("tools://progress", {
    tool: "helm",
    phase: "downloading",
    receivedBytes: 3_000_000,
    totalBytes: 12_000_000,
    error: null,
  });
  expect(rowText("helm")).toContain("Downloading helm v4.3.1 · 25%");
  expect(
    screen.getByTestId("pref-tool-progress-helm").getAttribute("aria-valuenow"),
  ).toBe("25");
  expect(screen.getByLabelText("Downloading")).toBeTruthy();

  await emitEvent("tools://progress", {
    tool: "helm",
    phase: "verifying",
    receivedBytes: 12_000_000,
    totalBytes: 12_000_000,
    error: null,
  });
  expect(rowText("helm")).toContain("Checking the checksum of helm v4.3.1");
  expect(
    screen
      .getByTestId("pref-tool-progress-helm")
      .hasAttribute("data-indeterminate"),
  ).toBe(true);

  fireEvent.click(screen.getByTestId("pref-tool-cancel-helm"));
  expect(backend.callsTo("tools_download_cancel")).toEqual([{ tool: "helm" }]);

  statuses = [
    toolStatus({ tool: "helm", source: "managed", path: "/data/helm" }),
    KUBECTL,
  ];
  await act(async () => {
    finish(statuses[0] as ToolStatus);
    await flush();
  });
  expect(success).toHaveBeenCalledWith(
    "helm v4.3.1 is ready",
    "Checksum verified · /data/helm",
  );
  expect(rowText("helm")).toBe("helm v4.3.1 · managed copy, checksum verified");
  expect(screen.queryByTestId("pref-tool-progress-helm")).toBeNull();
});

test("a cancelled download goes back to the missing row with its download", async () => {
  await show({
    tools_status: () => [HELM_MISSING, KUBECTL],
    tools_download: () => {
      throw { code: "Cancelled", message: "cancelled", details: null };
    },
  });
  fireEvent.click(screen.getByTestId("pref-tool-download-helm"));
  await act(flush);
  expect(rowText("helm")).toBe(
    "helm is not on PATH and no path is set. Helm screens need it; the rest of SkoposIDE works without it.Download helm v4.3.1",
  );
});

test("a status that cannot be read shows the error with Retry", async () => {
  let fail = true;
  await show({
    tools_status: () => {
      if (fail)
        throw { code: "Internal", message: "no data dir", details: null };
      return [HELM_MISSING, KUBECTL];
    },
  });
  expect(screen.getByText("Could not read the tool status")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(screen.getByTestId("pref-tool-helm")).toBeTruthy();
});
