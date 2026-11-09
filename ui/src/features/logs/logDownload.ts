import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef, useState } from "react";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { LogsDockTab } from "../../stores/dock";
import { logTarget } from "./useLogStream";

const UNITS = ["KiB", "MiB", "GiB"] as const;

/** "N B" under 1 KiB, else KiB, MiB or GiB with one decimal, in en-US. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString("en-US")} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = value.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${number} ${UNITS[unit]}`;
}

export interface DownloadNote {
  text: string;
  failed: boolean;
}

/**
 * Download all lines (spec §6.9): the save dialog, then `logs_download` with the tab's
 * target, Previous as set, no follow and no tail. One download runs at a time, so a
 * second press before the dialog opens asks nothing and writes nothing.
 */
export function useLogDownload(tab: LogsDockTab): {
  saving: boolean;
  note: DownloadNote | null;
  download(): Promise<void>;
} {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<DownloadNote | null>(null);
  const running = useRef(false);
  const latest = useRef(tab);
  latest.current = tab;

  const download = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSaving(true);
    const current = latest.current;
    try {
      const destPath = await save({
        defaultPath: `${current.name}.log`,
        filters: [{ name: "Log", extensions: ["log", "txt"] }],
      });
      if (destPath === null) return;
      const { bytes } = await api.logsDownload(
        current.clusterId,
        logTarget(current),
        {
          follow: false,
          previous: current.options.previous,
          tailLines: null,
          sinceSeconds: null,
        },
        destPath,
      );
      setNote({
        text: `Saved ${formatSize(bytes)} to ${destPath}`,
        failed: false,
      });
    } catch (e) {
      setNote({
        text: `Could not download the logs: ${failureMessage(e)}`,
        failed: true,
      });
    } finally {
      running.current = false;
      setSaving(false);
    }
  }, []);

  return { saving, note, download };
}
