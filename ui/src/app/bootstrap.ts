import { applyTheme, toast } from "../design";
import { events } from "../ipc/events";
import { usePrefs } from "../stores/prefs";

/**
 * Runs before the first render. The store warning listener must be in place
 * soon after page load, because the backend sends each warning only once.
 */
export async function bootstrap(): Promise<void> {
  applyTheme("system");
  await events.onStoreWarning((warning) => {
    toast.error(`Problem with ${warning.file}`, warning.message);
  });
  await usePrefs.getState().load();
  const { prefs } = usePrefs.getState();
  if (prefs) applyTheme(prefs.theme);
}
