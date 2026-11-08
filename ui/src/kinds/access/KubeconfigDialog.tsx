import { save } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { Button, Dialog, ErrorNotice, Select, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { KubeObject } from "../objects";

type Lifetime = "3600" | "28800" | "86400";

const LIFETIMES: { value: Lifetime; label: string }[] = [
  { value: "3600", label: "1 hour" },
  { value: "28800", label: "8 hours" },
  { value: "86400", label: "24 hours" },
];

/**
 * Writes a kubeconfig for a ServiceAccount, with a token from the TokenRequest API.
 * The backend writes the file, so the token never crosses IPC.
 */
export function KubeconfigDialog(props: {
  clusterId: string;
  object: KubeObject;
  close(): void;
}) {
  const { clusterId, object, close } = props;
  const { name, namespace = "" } = object.metadata;
  const [lifetime, setLifetime] = useState<Lifetime>("3600");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State lags a render behind, so a fast second click would get past `busy`.
  const running = useRef(false);

  async function saveFile() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const destPath = await save({
        defaultPath: `${name}.kubeconfig`,
        filters: [{ name: "Kubeconfig", extensions: ["kubeconfig", "yaml"] }],
      });
      if (destPath === null) return;
      const saved = await api.serviceAccountKubeconfigSave(
        clusterId,
        namespace,
        name,
        destPath,
        Number(lifetime),
      );
      toast.success(
        `Saved the kubeconfig · token expires ${new Date(saved.expiresAt).toLocaleString()}`,
      );
      close();
    } catch (e) {
      setError(failureMessage(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Save a kubeconfig for ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="kubeconfig-save"
            disabled={busy}
            onClick={() => void saveFile()}
          >
            Save…
          </Button>
        </>
      }
    >
      <p>
        The file holds a token from the TokenRequest API. Anyone with it acts as
        this ServiceAccount until the token expires.
      </p>
      <Select<Lifetime>
        label="Token lifetime"
        value={lifetime}
        options={LIFETIMES}
        onChange={setLifetime}
      />
      {error ? (
        <ErrorNotice title="Could not save the kubeconfig" message={error} />
      ) : null}
    </Dialog>
  );
}
