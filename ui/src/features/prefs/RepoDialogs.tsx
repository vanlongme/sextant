import { useState } from "react";
import { Button, ConfirmDialog, Dialog, Input } from "../../design";
import type { IpcFailure } from "../../ipc/client";
import { asFailure, useHelm } from "../../stores/helm";
import own from "../helm/Helm.module.css";
import styles from "./PreferencesScreen.module.css";

type Field = "name" | "url" | "username" | "password";
type Problems = Partial<Record<Field | "form", string>>;

const NAME = /^[A-Za-z0-9._-]+$/;

/** The checks of spec §11.5 that run once Add was pressed. */
export function checkRepo(fields: Record<Field, string>): Problems {
  const problems: Problems = {};
  if (!NAME.test(fields.name.trim())) {
    problems.name = "Letters, digits, dots, dashes and underscores";
  }
  const url = fields.url.trim().toLowerCase();
  if (url.startsWith("oci://")) {
    problems.url =
      "OCI registries are not supported here; add an http:// or https:// chart repository";
  } else if (!url.startsWith("http://") && !url.startsWith("https://")) {
    problems.url = "Use an http:// or https:// address";
  }
  if (fields.password !== "" && fields.username.trim() === "") {
    problems.username = "A password needs a username";
  }
  if (fields.username.trim() !== "" && fields.password === "") {
    problems.password = "A username needs a password";
  }
  return problems;
}

/** Where a refusal of `helm_repo_add` shows (spec §11.5). */
export function placeFailure(failure: IpcFailure): Problems {
  if (failure.code === "Conflict") return { name: failure.message };
  if (failure.code === "Unreachable") return { url: failure.message };
  if (failure.code === "InvalidInput") {
    const text = failure.message.toLowerCase();
    const field = (["username", "password", "url", "name"] as const).find((f) =>
      text.includes(f),
    );
    if (field) return { [field]: failure.message };
  }
  return { form: failure.message };
}

/** Add a chart repository (spec §11.5). */
export function RepoAddDialog(props: { onClose(): void }) {
  const addRepo = useHelm((s) => s.addRepo);
  const [fields, setFields] = useState<Record<Field, string>>({
    name: "",
    url: "",
    username: "",
    password: "",
  });
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<Problems>({});
  const [adding, setAdding] = useState(false);
  const problems = tried ? { ...checkRepo(fields), ...refusal } : refusal;

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setFields({ ...fields, [field]: e.target.value });
    setRefusal({});
  };

  async function add(): Promise<void> {
    setTried(true);
    if (Object.keys(checkRepo(fields)).length > 0) return;
    setAdding(true);
    try {
      await addRepo({
        name: fields.name.trim(),
        url: fields.url.trim(),
        username: fields.username.trim() === "" ? null : fields.username.trim(),
        password: fields.password === "" ? null : fields.password,
      });
      props.onClose();
    } catch (error) {
      setRefusal(placeFailure(asFailure(error)));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="Add a chart repository"
      testId="helm-repo-add-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={fields.name.trim() === "" || fields.url.trim() === ""}
            loading={adding}
            onClick={() => {
              void add();
            }}
            data-testid="helm-repo-add-submit"
          >
            Add
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <p className={styles.intro}>
          This runs helm repo add, so the repository is in your CLI too.
          Credentials go to helm's repositories.yaml, not to SkoposIDE.
        </p>
        <Input
          label="Name"
          placeholder="incubator"
          value={fields.name}
          error={problems.name}
          onChange={set("name")}
          data-testid="helm-repo-add-name"
        />
        <Input
          label="URL"
          placeholder="https://charts.example/stable"
          className={own.mono}
          value={fields.url}
          error={problems.url}
          onChange={set("url")}
          data-testid="helm-repo-add-url"
        />
        <Input
          label="Username, optional"
          help="For basic auth"
          value={fields.username}
          error={problems.username}
          onChange={set("username")}
          data-testid="helm-repo-add-username"
        />
        <Input
          label="Password, optional"
          type="password"
          value={fields.password}
          error={problems.password}
          onChange={set("password")}
          data-testid="helm-repo-add-password"
        />
        {problems.form ? (
          <p className={styles.formError} role="alert">
            {problems.form}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Remove a repository (spec §11.6). */
export function RepoRemoveDialog(props: { name: string; onClose(): void }) {
  const { name, onClose } = props;
  const removeRepo = useHelm((s) => s.removeRepo);
  const charts = useHelm((s) =>
    s.charts.search
      ? s.charts.search.charts.filter((c) => c.repo === name).length
      : null,
  );
  let leaving = "Its charts leave the chart list.";
  if (charts === 1) leaving = "Its 1 chart leaves the chart list.";
  else if (charts !== null)
    leaving = `Its ${charts} charts leave the chart list.`;
  return (
    <ConfirmDialog
      open
      title={`Remove repository ${name}?`}
      body={`This runs helm repo remove. ${leaving} Releases installed from it keep running and can still be uninstalled.`}
      confirmLabel="Remove"
      danger
      testId="helm-repo-remove-dialog"
      onConfirm={() => {
        void removeRepo(name);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
