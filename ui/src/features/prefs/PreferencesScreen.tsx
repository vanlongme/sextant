import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  IconButton,
  Input,
  Segmented,
  Spinner,
  toast,
} from "../../design";
import { failureMessage } from "../../ipc/client";
import type { SyncSource } from "../../ipc/generated/SyncSource";
import type { Theme } from "../../ipc/generated/Theme";
import { classifySourcePath, usePrefs } from "../../stores/prefs";
import styles from "./PreferencesScreen.module.css";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

function SourceRow({ source }: { source: SyncSource }) {
  const removeSource = usePrefs((s) => s.removeSource);
  return (
    <li className={styles.row} data-testid="pref-source-row">
      <Badge tone="neutral">{source.kind === "dir" ? "Folder" : "File"}</Badge>
      <span className={styles.path} title={source.path}>
        {source.path}
      </span>
      <IconButton
        label={`Remove ${source.path}`}
        icon={<X size={14} aria-hidden="true" />}
        onClick={() => void removeSource(source.path)}
      />
    </li>
  );
}

function Sources({ sources }: { sources: SyncSource[] }) {
  const addSource = usePrefs((s) => s.addSource);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | undefined>();

  async function add(source: SyncSource): Promise<boolean> {
    if (sources.some((s) => s.path === source.path)) {
      setProblem(`${source.path} is already listed`);
      return false;
    }
    setProblem(undefined);
    await addSource(source);
    return true;
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await add(classifySourcePath(text))) setText("");
  }

  async function browse(kind: SyncSource["kind"]): Promise<void> {
    try {
      const path = await open({ directory: kind === "dir", multiple: false });
      if (path) await add({ kind, path });
    } catch (error) {
      toast.error("Could not open the file picker", failureMessage(error));
    }
  }

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>Kubeconfig sources</h3>
      {sources.length === 0 ? (
        <EmptyState
          title="No kubeconfig sources"
          body="Add a file or a folder to list its contexts in the catalog."
        />
      ) : (
        <ul className={styles.rows}>
          {sources.map((source) => (
            <SourceRow key={source.path} source={source} />
          ))}
        </ul>
      )}
      <form className={styles.add} onSubmit={(e) => void submit(e)}>
        <div className={styles.input}>
          <Input
            aria-label="Path to a kubeconfig file, or a folder with a trailing separator"
            placeholder="/path/to/kubeconfig, or /path/to/folder/"
            value={text}
            error={problem}
            onChange={(e) => {
              setText(e.target.value);
              setProblem(undefined);
            }}
            data-testid="pref-source-input"
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={text.trim() === ""}
          data-testid="pref-source-add"
        >
          Add
        </Button>
        <Button onClick={() => void browse("file")}>Browse file</Button>
        <Button onClick={() => void browse("dir")}>Browse folder</Button>
      </form>
    </section>
  );
}

export function PreferencesScreen() {
  const prefs = usePrefs((s) => s.prefs);
  const loading = usePrefs((s) => s.loading);
  const error = usePrefs((s) => s.error);
  const load = usePrefs((s) => s.load);
  const setTheme = usePrefs((s) => s.setTheme);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className={styles.screen}>
        <ErrorNotice
          title="Preferences could not be loaded"
          message={error}
          onRetry={() => void load()}
        />
      </div>
    );
  }
  if (!prefs) {
    return <div className={styles.screen}>{loading ? <Spinner /> : null}</div>;
  }

  return (
    <div className={styles.screen}>
      <h2 className={styles.title}>Preferences</h2>
      <Sources sources={prefs.syncSources} />
      <section className={styles.section}>
        <h3 className={styles.heading}>Appearance</h3>
        <div className={styles.themeRow}>
          <span>Theme</span>
          <Segmented
            label="Theme"
            size="sm"
            value={prefs.theme}
            options={THEMES}
            onChange={(theme) => void setTheme(theme)}
            testId="prefs-theme"
          />
        </div>
      </section>
    </div>
  );
}
