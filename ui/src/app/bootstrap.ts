import { applyTheme, toast } from "../design";
import { events } from "../ipc/events";
import { restoreDockLayout } from "../stores/dockLayout";
import { usePortForwards } from "../stores/portForwards";
import { usePrefs } from "../stores/prefs";

/**
 * Runs before the first render. The store warning listener must be in place
 * soon after page load, because the backend sends each warning only once. The dock
 * layout is read at once; the dock shows nothing until it is applied.
 */
export async function bootstrap(): Promise<void> {
  applyTheme("system");
  const dock = restoreDockLayout();
  await events.onStoreWarning((warning) => {
    toast.error(`Problem with ${warning.file}`, warning.message);
  });
  await usePrefs.getState().load();
  // After the preferences (spec §4.2), and awaited last so a slow list holds up nothing.
  const forwards = usePortForwards.getState().load();
  const { prefs } = usePrefs.getState();
  if (prefs) applyTheme(prefs.theme);
  await dock;
  await forwards;
}
