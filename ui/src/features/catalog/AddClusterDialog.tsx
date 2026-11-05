import { useId, useState } from "react";
import { Button, Dialog, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import styles from "./CatalogScreen.module.css";

export function AddClusterDialog(props: { open: boolean; onClose(): void }) {
  const fieldId = useId();
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setYaml("");
    setError(null);
    props.onClose();
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ids = await api.catalogAddPasted(yaml);
      toast.success(
        ids.length === 1 ? "Added 1 cluster" : `Added ${ids.length} clusters`,
      );
      close();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Add cluster"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={yaml.trim() === ""}
            onClick={() => void submit()}
            data-testid="catalog-add-submit"
          >
            Add
          </Button>
        </>
      }
    >
      <label htmlFor={fieldId}>Kubeconfig YAML</label>
      <textarea
        id={fieldId}
        className={styles.yaml}
        rows={14}
        spellCheck={false}
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        data-testid="catalog-add-yaml"
      />
      {error ? (
        <p role="alert" className={styles.yamlError}>
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
