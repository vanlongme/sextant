import { ArrowLeft } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  Button,
  ErrorNotice,
  Input,
  RadioGroup,
  type RadioOption,
  Select,
  Spinner,
  toast,
} from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import { useCatalog } from "../../stores/catalog";
import { useClusterState } from "../../stores/clusters";
import { forgetProvider, useMetrics } from "../../stores/metrics";
import { useFetch } from "../helm/useFetch";
import styles from "./ClusterSettingsScreen.module.css";
import { dropDraft, keepDraft, keptDraft } from "./drafts";
import { IconField } from "./IconField";
import { overviewPath } from "./paths";
import {
  draftFrom,
  emptyDraft,
  type ProviderKind,
  prometheusPrefill,
  type SettingsDraft,
  sameDraft,
  settingsFrom,
  statusText,
  validate,
} from "./settingsForm";

/** The Select value that stands for no default namespace: the kubeconfig's. */
const FROM_KUBECONFIG = "__kubeconfig__";

const PROVIDERS: RadioOption<ProviderKind>[] = [
  {
    value: "auto",
    label: "Detect",
    description:
      "Look for a Prometheus Service across namespaces, then fall back to metrics-server",
  },
  {
    value: "prometheus",
    label: "Prometheus",
    description: "A Service you name, queried through the API server proxy",
  },
  {
    value: "metricsServer",
    label: "metrics-server only",
    description: "Current CPU and memory, no history",
  },
  { value: "none", label: "None", description: "No metrics for this cluster" },
];

function SettingsForm(props: {
  clusterId: string;
  name: string;
  contextName: string;
  /** The connected cluster's namespaces; empty when it is not connected. */
  namespaces: string[];
  initial: ClusterSettings;
}) {
  const { clusterId } = props;
  // Only the cached provider: this page never asks for it.
  const detected = useMetrics((s) => s.providers[clusterId]?.value);
  const [saved, setSaved] = useState(props.initial);
  // A draft kept from before a remount wins over the settings just read.
  const [draft, setDraft] = useState(
    () => keptDraft(clusterId) ?? draftFrom(props.initial),
  );
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const errors = validate(draft);
  const changed = !sameDraft(draft, draftFrom(saved));
  const canSave = changed && Object.keys(errors).length === 0 && !saving;

  useEffect(() => {
    if (changed) keepDraft(clusterId, draft);
    else dropDraft(clusterId);
  }, [clusterId, draft, changed]);

  function update(fields: Partial<SettingsDraft>): void {
    setDraft((d) => ({ ...d, ...fields }));
    setJustSaved(false);
  }

  function pickProvider(provider: ProviderKind): void {
    const prefill =
      provider === "prometheus" &&
      saved.metricsProvider.kind !== "prometheus" &&
      draft.promNamespace === "" &&
      draft.promService === "" &&
      draft.promPort === "";
    update(
      prefill ? { provider, ...prometheusPrefill(detected) } : { provider },
    );
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    const next = settingsFrom(draft, saved);
    setSaving(true);
    try {
      await api.clusterSettingsSet(clusterId, next);
      toast.success(
        `Saved the settings for ${next.displayName ?? props.contextName}`,
        next.proxyUrl === saved.proxyUrl
          ? undefined
          : "Reconnect to use the new proxy.",
      );
      forgetProvider(clusterId);
      setSaved(next);
      setDraft(draftFrom(next));
      setJustSaved(true);
    } catch (error) {
      toast.error(
        `Could not save the settings for ${props.name}`,
        failureMessage(error),
      );
    } finally {
      setSaving(false);
    }
  }

  const namespaces = [...props.namespaces];
  if (
    saved.defaultNamespace !== null &&
    !namespaces.includes(saved.defaultNamespace)
  ) {
    namespaces.push(saved.defaultNamespace);
  }
  const namespaceOptions = [
    { value: FROM_KUBECONFIG, label: "From the kubeconfig" },
    ...namespaces.map((n) => ({ value: n, label: n })),
  ];

  return (
    <form className={styles.form} onSubmit={(e) => void save(e)}>
      <section className={styles.section}>
        <h2 className={styles.heading}>General</h2>
        <div className={styles.grid}>
          <Input
            label="Display name"
            help="Shown in the hotbar, the catalog and the title"
            placeholder={props.contextName}
            value={draft.displayName}
            onChange={(e) => update({ displayName: e.target.value })}
            data-testid="settings-display-name"
          />
        </div>
        <IconField icon={draft.icon} onChange={(icon) => update({ icon })} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Namespaces</h2>
        <div className={styles.grid}>
          <Select
            label="Default namespace"
            value={draft.defaultNamespace ?? FROM_KUBECONFIG}
            options={namespaceOptions}
            onChange={(v) =>
              update({ defaultNamespace: v === FROM_KUBECONFIG ? null : v })
            }
            testId="settings-default-namespace"
          />
          <Input
            label="Accessible namespaces"
            help="Comma separated. When set, SkoposIDE watches only these"
            className={styles.mono}
            value={draft.accessibleNamespaces}
            error={errors.accessibleNamespaces}
            onChange={(e) => update({ accessibleNamespaces: e.target.value })}
            data-testid="settings-accessible-namespaces"
          />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Terminal and node shell</h2>
        <div className={styles.grid}>
          <Input
            label="Terminal working directory"
            help="Where the local terminal of this cluster starts"
            className={styles.mono}
            value={draft.terminalCwd}
            onChange={(e) => update({ terminalCwd: e.target.value })}
            data-testid="settings-terminal-cwd"
          />
          <Input
            label="Node shell image"
            help="The privileged Pod that enters a node"
            className={styles.mono}
            value={draft.nodeShellImage}
            error={errors.nodeShellImage}
            onChange={(e) => update({ nodeShellImage: e.target.value })}
            data-testid="settings-node-shell-image"
          />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Network</h2>
        <Input
          label="Proxy URL"
          help="For this cluster's API server. Empty uses the kubeconfig's proxy-url, if it has one"
          className={styles.mono}
          value={draft.proxyUrl}
          error={errors.proxyUrl}
          onChange={(e) => update({ proxyUrl: e.target.value })}
          data-testid="settings-proxy-url"
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Metrics</h2>
        <RadioGroup
          legend="Metrics provider"
          value={draft.provider}
          options={PROVIDERS}
          onChange={pickProvider}
          testId="settings-metrics"
        />
        {draft.provider === "prometheus" ? (
          <div className={styles.promGrid}>
            <Input
              label="Namespace"
              className={styles.mono}
              value={draft.promNamespace}
              error={errors.promNamespace}
              onChange={(e) => update({ promNamespace: e.target.value })}
              data-testid="settings-prom-namespace"
            />
            <Input
              label="Service"
              className={styles.mono}
              value={draft.promService}
              error={errors.promService}
              onChange={(e) => update({ promService: e.target.value })}
              data-testid="settings-prom-service"
            />
            <Input
              label="Port"
              inputMode="numeric"
              className={styles.mono}
              value={draft.promPort}
              error={errors.promPort}
              onChange={(e) => update({ promPort: e.target.value })}
              data-testid="settings-prom-port"
            />
          </div>
        ) : null}
      </section>

      <footer className={styles.footer}>
        <p
          className={styles.status}
          role="status"
          data-testid="settings-status"
        >
          {statusText(errors, changed, justSaved)}
        </p>
        <Button
          size="sm"
          onClick={() => update(emptyDraft())}
          data-testid="settings-restore"
        >
          Restore defaults
        </Button>
        <Button
          size="sm"
          disabled={!changed}
          onClick={() => {
            setDraft(draftFrom(saved));
            setJustSaved(false);
          }}
          data-testid="settings-reset"
        >
          Reset
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSave}
          loading={saving}
          data-testid="settings-save"
        >
          Save
        </Button>
      </footer>
    </form>
  );
}

/** The Settings page of one cluster, connected or not. */
export function ClusterSettingsScreen(props: { clusterId: string }) {
  const { clusterId } = props;
  const cluster = useCatalog((s) => s.clusters.find((c) => c.id === clusterId));
  const state = useClusterState(clusterId);
  const navigate = useNavigate();
  const settings = useFetch(clusterId, () => api.clusterSettingsGet(clusterId));
  const name = cluster?.name ?? clusterId;
  const connected = state.status === "connected";

  let body: ReactNode;
  if (settings.error) {
    body = (
      <ErrorNotice
        title="Could not read the settings"
        message={settings.error.message}
        onRetry={settings.retry}
      />
    );
  } else if (settings.value === undefined) {
    body = <Spinner label="Loading" />;
  } else {
    body = (
      <SettingsForm
        clusterId={clusterId}
        name={name}
        contextName={cluster?.contextName ?? clusterId}
        namespaces={state.status === "connected" ? state.info.namespaces : []}
        initial={settings.value}
      />
    );
  }

  return (
    <div className={styles.page} data-testid="cluster-settings">
      <div className={styles.column}>
        <header className={styles.head}>
          <div className={styles.titles}>
            <h1 className={styles.title} data-testid="settings-title">
              Settings for {name}
            </h1>
            {cluster ? (
              <p className={styles.sub}>
                Context {cluster.contextName} in {cluster.source.path}. These
                settings stay in SkoposIDE; the kubeconfig file is not changed.
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            onClick={() => navigate(overviewPath(clusterId))}
            data-testid="settings-back"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {connected ? `Back to ${name}` : `Open ${name}`}
          </Button>
        </header>
        {body}
      </div>
    </div>
  );
}

/** The `settings` child route of a cluster. */
export function ClusterSettingsRoute() {
  const { id = "" } = useParams();
  return <ClusterSettingsScreen key={id} clusterId={id} />;
}
