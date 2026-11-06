import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, ConfirmDialog, ErrorNotice, Menu } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { ApplyResult } from "../../ipc/generated/ApplyResult";
import {
  type DockTab,
  readDraft,
  useDock,
  writeDraft,
} from "../../stores/dock";
import { namespaceFilterKey } from "../resources/NamespaceFilter";
import { TEMPLATES } from "./templates";
import { validateYaml, yamlProblem } from "./validate";
import { YamlEditor } from "./YamlEditor";
import styles from "./YamlEditor.module.css";

export interface CreateDraft {
  text: string;
  /** Text that counts as nothing to lose: a template as it came, or what was applied. */
  baseline: string;
  results: ApplyResult[];
}

/** Where documents with no namespace go: the first in the cluster's filter. */
async function defaultNamespace(clusterId: string): Promise<string> {
  try {
    const saved = await api.uiStateGet(namespaceFilterKey(clusterId));
    if (Array.isArray(saved) && typeof saved[0] === "string" && saved[0]) {
      return saved[0];
    }
  } catch {
    // No saved filter to go by.
  }
  return "default";
}

function resultLabel(result: ApplyResult): string {
  if (!result.kind || !result.name) return `Document ${result.index + 1}`;
  const object = result.namespace
    ? `${result.namespace}/${result.name}`
    : result.name;
  return `${result.kind} ${object}`;
}

/** Applies multi-document YAML and reports each document on its own. */
export function CreateResourceTab(props: {
  tab: Extract<DockTab, { kind: "create" }>;
}) {
  const { id, clusterId } = props.tab;
  const [restored] = useState(() => readDraft<CreateDraft>(id));
  const [text, setText] = useState(restored?.text ?? "");
  const [baseline, setBaseline] = useState(restored?.baseline ?? "");
  const [results, setResults] = useState(restored?.results ?? []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [replacing, setReplacing] = useState<(typeof TEMPLATES)[number] | null>(
    null,
  );

  const dirty = text.trim() !== "" && text !== baseline;
  const check = useMemo(() => validateYaml(text), [text]);

  useEffect(() => {
    useDock.getState().setDirty(id, dirty);
  }, [id, dirty]);

  useEffect(() => {
    writeDraft(id, { text, baseline, results } satisfies CreateDraft);
  }, [id, text, baseline, results]);

  function fill(template: (typeof TEMPLATES)[number]): void {
    setText(template.yaml);
    setBaseline(template.yaml);
    setResults([]);
    setFailure(null);
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setFailure(null);
    setResults([]);
    try {
      const namespace = await defaultNamespace(clusterId);
      const applied = await api.resourceApply(clusterId, text, namespace);
      setResults(applied);
      if (applied.every((r) => r.ok)) setBaseline(text);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.tab}>
      <div className={styles.toolbar}>
        <Menu
          trigger={
            <Button size="sm" data-testid="create-template">
              Template
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          }
          items={TEMPLATES.map((template) => ({
            id: template.id,
            label: template.label,
            onSelect: () => (dirty ? setReplacing(template) : fill(template)),
          }))}
        />
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!check.ok || check.documents === 0}
          onClick={() => void apply()}
          data-testid="create-apply"
        >
          Apply
        </Button>
        <span className={styles.hint}>
          A document with no namespace goes to the first namespace selected in
          the namespace filter, or to default.
        </span>
      </div>
      {check.ok ? null : (
        <div className={styles.problem} role="alert" data-testid="yaml-error">
          {yamlProblem(check)}
        </div>
      )}
      {failure ? (
        <div className={styles.apiError} data-testid="yaml-api-error">
          <ErrorNotice
            title="Nothing was applied"
            message={failureMessage(failure)}
            details={
              failure instanceof IpcFailure ? failure.details : undefined
            }
          />
        </div>
      ) : null}
      <YamlEditor
        value={text}
        onChange={setText}
        readOnly={busy}
        testId="yaml-editor"
      />
      {results.length > 0 ? (
        <ul className={styles.results} data-testid="apply-results">
          {results.map((result) => (
            <li
              key={result.index}
              className={styles.result}
              data-testid={`apply-result-${result.index}`}
              data-ok={result.ok}
            >
              <Badge tone={result.ok ? "ok" : "danger"}>
                {result.ok ? "Applied" : "Failed"}
              </Badge>
              <span className={styles.resultName}>{resultLabel(result)}</span>
              <span className={styles.resultMessage}>{result.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {replacing ? (
        <ConfirmDialog
          open
          title="Replace the text?"
          body={`The ${replacing.label} template replaces what you have typed.`}
          confirmLabel="Replace"
          danger
          onConfirm={() => {
            fill(replacing);
            setReplacing(null);
          }}
          onCancel={() => setReplacing(null)}
        />
      ) : null}
    </div>
  );
}
