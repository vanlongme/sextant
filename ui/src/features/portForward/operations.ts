import { api } from "../../ipc/api";
import type { PortForward } from "../../ipc/generated/PortForward";
import type { PortForwardSpec } from "../../ipc/generated/PortForwardSpec";

/*
 * The operations the dialog, the screen and the drawer share (spec §4.3). Each
 * rejects with the backend's error and leaves the store to `portforward://changed`.
 */

/** Adds the definition and starts it. A failed start removes the new definition. */
export async function createAndStart(
  spec: PortForwardSpec,
): Promise<PortForward> {
  const added = await api.portforwardAdd(spec);
  try {
    return await api.portforwardStart(added.id);
  } catch (error) {
    // The start's error is what the user needs; a failed cleanup adds nothing to it.
    await api.portforwardRemove(added.id).catch(() => {});
    throw error;
  }
}

export function start(id: string): Promise<PortForward> {
  return api.portforwardStart(id);
}

export function stop(id: string): Promise<void> {
  return api.portforwardStop(id);
}

export function remove(id: string): Promise<void> {
  return api.portforwardRemove(id);
}

export async function restart(id: string): Promise<PortForward> {
  await stop(id);
  return start(id);
}

export interface RemoveFailure {
  id: string;
  error: unknown;
}

/** Removes one at a time; a failure does not stop the others. */
export async function removeMany(ids: string[]): Promise<RemoveFailure[]> {
  const failures: RemoveFailure[] = [];
  for (const id of ids) {
    try {
      await remove(id);
    } catch (error) {
      failures.push({ id, error });
    }
  }
  return failures;
}

export function browserUrl(boundPort: number): string {
  return `http://127.0.0.1:${boundPort}/`;
}

/** Opens the forward's address. Only a running forward with a bound port offers this. */
export async function openInBrowser(forward: PortForward): Promise<void> {
  if (forward.boundPort === null) {
    throw new Error("The port forward is not listening");
  }
  await api.openExternal(browserUrl(forward.boundPort));
}
