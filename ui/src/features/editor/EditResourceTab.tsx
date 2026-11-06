import { useCallback, useEffect, useMemo, useState } from "react";
import { stringify } from "yaml";
import { Button, Dialog, ErrorNotice, Spinner } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  clearDraft,
  type DockTab,
  newCreateTab,
  readDraft,
  useDock,
  writeDraft,
} from "../../stores/dock";
import type { CreateDraft } from "./CreateResourceTab";
import { stripServerFields, validateYaml, yamlProblem } from "./validate";
import { YamlEditor } from "./YamlEditor";
import styles from "./YamlEditor.module.css";

interface EditDraft {
  text: string;
  /** The text as it came from the server, which holds the version the edit is against. */
  loaded: string;
}

function hasCode(error: unknown, code: IpcFailure["code"]): boolean {
  return error instanceof IpcFailure && error.code === code;
}

function detailsOf(error: unknown): string | undefined {
  return error instanceof IpcFailure ? error.details : undefined;
}

function skeleton(
  resource: ResourceRef,
  namespace: string | undefined,
  name: string,
): string {
  return stringify({
    apiVersion: resource.group
      ? `${resource.group}/${resource.version}`
      : resource.version,
    kind: resource.kind,
    metadata: namespace ? { name, namespace } : { name },
  });
}

/** Edits one object's YAML: PUT with its `resourceVersion`, and a dialog on a 409. */
export function EditResourceTab(props: {
  tab: Extract<DockTab, { kind: "edit" }>;
}) {
  const { id, clusterId, resource, namespace, name, title } = props.tab;
  const [restored] = useState(() => readDraft<EditDraft>(id));
  const [text, setText] = useState(restored?.text ?? "");
  const [loaded, setLoaded] = useState(restored?.loaded ?? "");
  const [status, setStatus] = useState<"loading" | "ready" | "gone" | "failed">(
    restored ? "ready" : "loading",
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [apiError, setApiError] = useState<{
    title: string;
    error: unknown;
  } | null>(null);

  const dirty = text !== loaded;
  const check = useMemo(() => validateYaml(text), [text]);
  let problem: string | null = null;
  if (!check.ok) problem = yamlProblem(check);
  else if (check.documents !== 1)
    problem = "The editor must hold exactly one YAML document.";

  const read = useCallback(
    () => api.resourceGetYaml(clusterId, resource, namespace ?? null, name),
    [clusterId, resource, namespace, name],
  );

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const yaml = await read();
      setText(yaml);
      setLoaded(yaml);
      setStatus("ready");
    } catch (error) {
      if (hasCode(error, "NotFound")) {
        setStatus("gone");
      } else {
        setLoadError(error);
        setStatus("failed");
      }
    }
  }, [read]);

  useEffect(() => {
    if (!restored) void load();
  }, [restored, load]);

  useEffect(() => {
    useDock.getState().setDirty(id, dirty);
    if (dirty) writeDraft(id, { text, loaded } satisfies EditDraft);
    else clearDraft(id);
  }, [id, dirty, text, loaded]);

  /** Shows the stored object. `onFailure` is for an error other than it being gone. */
  async function reload(onFailure: (error: unknown) => void): Promise<void> {
    try {
      const yaml = await read();
      setText(yaml);
      setLoaded(yaml);
    } catch (error) {
      if (hasCode(error, "NotFound")) setStatus("gone");
      else onFailure(error);
    }
  }

  async function save(force: boolean): Promise<void> {
    setBusy(true);
    setConflict(false);
    setApiError(null);
    try {
      await api.resourceReplace(
        clusterId,
        resource,
        namespace ?? null,
        name,
        text,
        force,
      );
    } catch (error) {
      if (hasCode(error, "Conflict")) setConflict(true);
      else if (hasCode(error, "NotFound")) setStatus("gone");
      else setApiError({ title: "Not saved", error });
      setBusy(false);
      return;
    }
    await reload((error) => {
      // What was typed is on the server now, so the edits are not at risk.
      setLoaded(text);
      setApiError({ title: "Saved, but could not reload", error });
    });
    setBusy(false);
  }

  async function discardAndReload(): Promise<void> {
    setBusy(true);
    setConflict(false);
    setApiError(null);
    await reload((error) => setApiError({ title: "Could not reload", error }));
    setBusy(false);
  }

  function createInstead(): void {
    const dock = useDock.getState();
    const created = newCreateTab(clusterId);
    const source = text.trim()
      ? stripServerFields(text)
      : skeleton(resource, namespace, name);
    dock.open(created);
    writeDraft(created.id, {
      text: source,
      baseline: "",
      results: [],
    } satisfies CreateDraft);
    dock.close(id);
  }

  if (status === "loading") {
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className={styles.tab}>
        <ErrorNotice
          title={`Could not open ${title}`}
          message={failureMessage(loadError)}
          details={detailsOf(loadError)}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  const gone = status === "gone";
  return (
    <div className={styles.tab}>
      {gone ? (
        <div className={styles.notice} data-testid="yaml-deleted">
          <span className={styles.grow}>
            {title} was deleted on the server.
          </span>
          <Button
            size="sm"
            onClick={createInstead}
            data-testid="yaml-create-instead"
          >
            Create instead
          </Button>
        </div>
      ) : (
        <div className={styles.toolbar}>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!dirty || problem !== null}
            onClick={() => void save(false)}
            data-testid="yaml-save"
          >
            Save
          </Button>
          <span className={styles.hint}>
            {dirty ? "Unsaved changes" : "No changes"}
          </span>
        </div>
      )}
      {!gone && problem ? (
        <div className={styles.problem} role="alert" data-testid="yaml-error">
          {problem}
        </div>
      ) : null}
      {apiError ? (
        <div className={styles.apiError} data-testid="yaml-api-error">
          <ErrorNotice
            title={apiError.title}
            message={failureMessage(apiError.error)}
            details={detailsOf(apiError.error)}
          />
        </div>
      ) : null}
      {gone && !text ? null : (
        <YamlEditor
          value={text}
          onChange={setText}
          readOnly={busy || gone}
          testId="yaml-editor"
        />
      )}
      {conflict ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setConflict(false);
          }}
          title="Changed on the server"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConflict(false)}>
                Keep editing
              </Button>
              <Button
                onClick={() => void discardAndReload()}
                data-testid="conflict-reload"
              >
                Reload
              </Button>
              <Button
                variant="danger"
                onClick={() => void save(true)}
                data-testid="conflict-overwrite"
              >
                Overwrite
              </Button>
            </>
          }
        >
          <p data-testid="conflict-dialog">
            {title} changed on the server after it was opened here. Reload
            discards your edits. Overwrite replaces the server's version with
            yours.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
