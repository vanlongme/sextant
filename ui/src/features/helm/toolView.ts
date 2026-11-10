import type { ToolProgress } from "../../ipc/generated/ToolProgress";
import type { ToolStatus } from "../../ipc/generated/ToolStatus";
import { isChecksumFailure } from "../../stores/helm";

export interface ToolView {
  tone: "ok" | "warn" | "danger";
  text: string;
  /** A download is going: show the bar and Cancel. */
  inFlight: boolean;
  /** 0 to 100 while downloading with a known size; null shows a moving bar. */
  percent: number | null;
  /** "Download ‹tool› ‹managedVersion›" when that button shows, else null. */
  download: string | null;
}

const MISSING: Record<ToolStatus["tool"], string> = {
  helm: "helm is not on PATH and no path is set. Helm screens need it; the rest of SkoposIDE works without it.",
  kubectl:
    "kubectl is not on PATH and no path is set. Terminals use it; the rest of SkoposIDE works without it.",
};

function inFlightText(
  tool: string,
  version: string,
  progress: ToolProgress | undefined,
): { text: string; percent: number | null } {
  const name = `${tool} ${version}`.trim();
  if (progress?.phase === "verifying") {
    return { text: `Checking the checksum of ${name}`, percent: null };
  }
  if (progress?.phase === "extracting") {
    return { text: `Unpacking ${name}`, percent: null };
  }
  const received = progress?.receivedBytes ?? 0;
  const total = progress?.totalBytes ?? null;
  if (total !== null && total > 0) {
    const percent = Math.min(100, Math.floor((received * 100) / total));
    return { text: `Downloading ${name} · ${percent}%`, percent };
  }
  return {
    text: `Downloading ${name} · ${(received / 1e6).toFixed(1)} MB`,
    percent: null,
  };
}

/** The Tools row of spec §12.1, from the status and the last progress event. */
export function toolView(
  status: ToolStatus,
  progress: ToolProgress | undefined,
): ToolView {
  const { tool } = status;
  const managed = status.managedVersion ?? "";
  const going =
    progress?.phase === "downloading" ||
    progress?.phase === "verifying" ||
    progress?.phase === "extracting" ||
    (status.downloading && progress?.phase !== "failed");
  if (going) {
    return {
      tone: "warn",
      ...inFlightText(tool, managed, progress),
      inFlight: true,
      download: null,
    };
  }
  const name = [tool, status.version].filter(Boolean).join(" ");
  const download =
    status.managedVersion === null
      ? null
      : `Download ${tool} ${status.managedVersion}`;
  const plain = (tone: ToolView["tone"], text: string): ToolView => ({
    tone,
    text,
    inFlight: false,
    percent: null,
    download: null,
  });
  switch (status.source) {
    case "path":
      return plain("ok", `${name} · found on PATH at ${status.path ?? ""}`);
    case "managed":
      return plain("ok", `${name} · managed copy, checksum verified`);
    case "preferences":
      return status.problem
        ? plain("danger", status.problem)
        : plain("ok", `${name} · set in Preferences at ${status.path ?? ""}`);
    case "missing":
      break;
  }
  let text = MISSING[tool];
  if (progress?.phase === "failed" && progress.error?.code !== "Cancelled") {
    text = isChecksumFailure(progress)
      ? "The checksum did not match, so the file was deleted. Try again."
      : `Could not download ${tool}: ${progress.error?.message ?? ""}`;
  }
  return { ...plain("danger", text), download };
}
