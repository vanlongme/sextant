import { expect, test } from "vitest";
import type { ToolProgress } from "../../ipc/generated/ToolProgress";
import { toolStatus } from "../../test/helm";
import { toolView } from "./toolView";

const missing = toolStatus({
  tool: "helm",
  source: "missing",
  path: null,
  version: null,
});

function progress(over: Partial<ToolProgress>): ToolProgress {
  return {
    tool: "helm",
    phase: "downloading",
    receivedBytes: 0,
    totalBytes: null,
    error: null,
    ...over,
  };
}

test.each([
  [
    "found on PATH",
    toolStatus({ tool: "helm" }),
    "ok",
    "helm v4.3.1 · found on PATH at /usr/local/bin/helm",
  ],
  [
    "a managed copy",
    toolStatus({ tool: "helm", source: "managed" }),
    "ok",
    "helm v4.3.1 · managed copy, checksum verified",
  ],
  [
    "a Preferences path",
    toolStatus({
      tool: "kubectl",
      source: "preferences",
      path: "/opt/kubectl",
    }),
    "ok",
    "kubectl v4.3.1 · set in Preferences at /opt/kubectl",
  ],
  [
    "a Preferences path with a problem",
    toolStatus({
      tool: "helm",
      source: "preferences",
      problem: "/opt/helm is not executable",
    }),
    "danger",
    "/opt/helm is not executable",
  ],
  [
    "no version",
    toolStatus({ tool: "helm", version: null }),
    "ok",
    "helm · found on PATH at /usr/local/bin/helm",
  ],
  [
    "helm missing",
    missing,
    "danger",
    "helm is not on PATH and no path is set. Helm screens need it; the rest of SkoposIDE works without it.",
  ],
  [
    "kubectl missing",
    { ...missing, tool: "kubectl" as const },
    "danger",
    "kubectl is not on PATH and no path is set. Terminals use it; the rest of SkoposIDE works without it.",
  ],
])("%s", (_name, status, tone, text) => {
  expect(toolView(status, undefined)).toMatchObject({
    tone,
    text,
    inFlight: false,
  });
});

test("a missing tool with a managed version offers the download", () => {
  expect(toolView(missing, undefined).download).toBe("Download helm v4.3.1");
  expect(
    toolView({ ...missing, managedVersion: null }, undefined).download,
  ).toBeNull();
  expect(toolView(toolStatus({ tool: "helm" }), undefined).download).toBeNull();
});

test.each([
  [
    progress({ receivedBytes: 4_200_000, totalBytes: 16_800_000 }),
    "Downloading helm v4.3.1 · 25%",
    25,
  ],
  [
    progress({ receivedBytes: 4_250_000 }),
    "Downloading helm v4.3.1 · 4.3 MB",
    null,
  ],
  [
    progress({ phase: "verifying" }),
    "Checking the checksum of helm v4.3.1",
    null,
  ],
  [progress({ phase: "extracting" }), "Unpacking helm v4.3.1", null],
])("in flight: %j", (event, text, percent) => {
  expect(toolView(missing, event)).toEqual({
    tone: "warn",
    text,
    inFlight: true,
    percent,
    download: null,
  });
});

test("a download the status reports before any event reads 0.0 MB", () => {
  expect(toolView({ ...missing, downloading: true }, undefined).text).toBe(
    "Downloading helm v4.3.1 · 0.0 MB",
  );
});

test("failures: the checksum, another error, and a cancel that says nothing", () => {
  const failed = (code: "Internal" | "Cancelled", message: string) =>
    progress({ phase: "failed", error: { code, message, details: null } });
  expect(
    toolView(
      missing,
      failed(
        "Internal",
        "the downloaded file does not match its pinned SHA-256 checksum",
      ),
    ),
  ).toMatchObject({
    tone: "danger",
    text: "The checksum did not match, so the file was deleted. Try again.",
    download: "Download helm v4.3.1",
  });
  expect(toolView(missing, failed("Internal", "no route to host")).text).toBe(
    "Could not download helm: no route to host",
  );
  expect(toolView(missing, failed("Cancelled", "cancelled")).text).toBe(
    toolView(missing, undefined).text,
  );
});
