import { useState } from "react";
import { Button, Dialog, ErrorNotice, Input, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../objects";

export function ScaleDialog(props: {
  clusterId: string;
  resource: ResourceRef;
  object: KubeObject;
  close(): void;
}) {
  const { clusterId, resource, object, close } = props;
  const { name, namespace = "" } = object.metadata;
  const [value, setValue] = useState(String(object.spec?.replicas ?? 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d+$/.test(value);

  async function confirm() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.workloadScale(
        clusterId,
        resource,
        namespace,
        name,
        Number(value),
      );
      toast.success(`Scaled ${name} to ${value}`);
      close();
    } catch (e) {
      setError(failureMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Scale ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="scale-confirm"
            disabled={!valid || busy}
            onClick={confirm}
          >
            Scale
          </Button>
        </>
      }
    >
      <Input
        label="Replicas"
        data-testid="scale-replicas"
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={valid ? undefined : "Enter a whole number, 0 or more."}
        onKeyDown={(e) => {
          if (e.key === "Enter") void confirm();
        }}
      />
      {error ? <ErrorNotice title="Scale failed" message={error} /> : null}
    </Dialog>
  );
}
