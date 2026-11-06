import type { editor as MonacoEditor } from "monaco-editor/editor/editor.api";
import { useEffect, useRef, useState } from "react";
import { ErrorNotice, Spinner } from "../../design";
import styles from "./YamlEditor.module.css";

/** A Monaco editor for YAML. The editor's code loads when the first one mounts. */
export function YamlEditor(props: {
  value: string;
  onChange(v: string): void;
  readOnly?: boolean;
  testId?: string;
}): React.JSX.Element {
  const { value, readOnly = false } = props;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  // What the editor needs when it finishes loading, or on a later change.
  const latest = useRef({ value, readOnly, onChange: props.onChange });
  latest.current = { value, readOnly, onChange: props.onChange };
  // True while `value` is being put in the editor, which is not a user's change.
  const applying = useRef(false);

  useEffect(() => {
    let gone = false;
    let dispose = () => {};
    import("./monaco")
      .then(({ monaco, currentTheme }) => {
        if (gone || !host.current) return;
        const created = monaco.editor.create(host.current, {
          value: latest.current.value,
          readOnly: latest.current.readOnly,
          language: "yaml",
          theme: currentTheme(),
          ariaLabel: "YAML editor",
          automaticLayout: true,
          detectIndentation: false,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 13,
          insertSpaces: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
        });
        const listener = created.onDidChangeModelContent(() => {
          if (!applying.current) latest.current.onChange(created.getValue());
        });
        editor.current = created;
        setState("ready");
        dispose = () => {
          listener.dispose();
          const model = created.getModel();
          created.dispose();
          model?.dispose();
          editor.current = null;
        };
      })
      .catch(() => {
        if (!gone) setState("failed");
      });
    return () => {
      gone = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    const current = editor.current;
    if (!current || current.getValue() === value) return;
    applying.current = true;
    current.setValue(value);
    applying.current = false;
  }, [value]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return (
    <div className={styles.editor} data-testid={props.testId}>
      <div ref={host} className={styles.host} />
      {state === "loading" ? (
        <div className={styles.overlay}>
          <Spinner />
        </div>
      ) : null}
      {state === "failed" ? (
        <div className={styles.overlay}>
          <ErrorNotice
            title="No editor"
            message="The editor could not be loaded."
          />
        </div>
      ) : null}
    </div>
  );
}
