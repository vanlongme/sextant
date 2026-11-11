import type { SettingsDraft } from "./settingsForm";

/**
 * The unsaved Settings draft of each cluster, in memory only. The page remounts when its
 * cluster connects or disconnects, since it moves into or out of the cluster layout; a
 * draft kept here survives that. The page drops it once the draft matches the saved
 * settings again: after Save, Reset, or edits that undo themselves.
 */
const drafts = new Map<string, SettingsDraft>();

export function keptDraft(clusterId: string): SettingsDraft | undefined {
  return drafts.get(clusterId);
}

export function keepDraft(clusterId: string, draft: SettingsDraft): void {
  drafts.set(clusterId, draft);
}

export function dropDraft(clusterId: string): void {
  drafts.delete(clusterId);
}

export function resetDraftsForTest(): void {
  drafts.clear();
}
