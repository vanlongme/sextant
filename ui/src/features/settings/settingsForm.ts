import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsProviderSetting } from "../../ipc/generated/MetricsProviderSetting";

/** Detect, Prometheus, metrics-server only or None. */
export type ProviderKind = MetricsProviderSetting["kind"];

/** The Settings page's fields as the user types them. */
export interface SettingsDraft {
  displayName: string;
  icon: string | null;
  defaultNamespace: string | null;
  /** As typed: names split by commas and spaces. */
  accessibleNamespaces: string;
  terminalCwd: string;
  nodeShellImage: string;
  proxyUrl: string;
  provider: ProviderKind;
  promNamespace: string;
  promService: string;
  promPort: string;
}

export type DraftField =
  | "accessibleNamespaces"
  | "nodeShellImage"
  | "proxyUrl"
  | "promNamespace"
  | "promService"
  | "promPort";

export type DraftErrors = Partial<Record<DraftField, string>>;

export const ICON_MAX_BYTES = 262_144;
export const ICON_ERROR = "Pick a PNG or SVG image up to 256 KB";

/** The Prometheus fields when nothing better is known: the operator's governing Service. */
export const PROMETHEUS_DEFAULTS: Readonly<
  Pick<SettingsDraft, "promNamespace" | "promService" | "promPort">
> = {
  promNamespace: "observability",
  promService: "prometheus-operated",
  promPort: "9090",
};

const ICON_TYPES = ["image/png", "image/svg+xml"];
const ICON_NAME = /\.(png|svg)$/i;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const PROXY_PROTOCOLS = ["http:", "https:", "socks5:"];
const PROXY_ERROR =
  "Use http://, https:// or socks5:// with a host and an optional port";

export function draftFrom(settings: ClusterSettings): SettingsDraft {
  const provider = settings.metricsProvider;
  const prom = provider.kind === "prometheus" ? provider : null;
  return {
    displayName: settings.displayName ?? "",
    icon: settings.icon,
    defaultNamespace: settings.defaultNamespace,
    accessibleNamespaces: settings.accessibleNamespaces.join(", "),
    terminalCwd: settings.terminalCwd ?? "",
    nodeShellImage: settings.nodeShellImage ?? "",
    proxyUrl: settings.proxyUrl ?? "",
    provider: provider.kind,
    promNamespace: prom?.namespace ?? "",
    promService: prom?.service ?? "",
    promPort: prom ? String(prom.port) : "",
  };
}

/** Restore defaults: empty fields, no icon, no accessible namespaces and Detect. */
export function emptyDraft(): SettingsDraft {
  return {
    displayName: "",
    icon: null,
    defaultNamespace: null,
    accessibleNamespaces: "",
    terminalCwd: "",
    nodeShellImage: "",
    proxyUrl: "",
    provider: "auto",
    promNamespace: "",
    promService: "",
    promPort: "",
  };
}

/** Names split on commas and whitespace, without empty ones or repeats, in order. */
export function splitNamespaces(text: string): string[] {
  const names = new Set<string>();
  for (const part of text.split(/[\s,]+/)) {
    if (part !== "") names.add(part);
  }
  return [...names];
}

/** A DNS-1123 label, as a namespace name is. */
export function isDnsLabel(s: string): boolean {
  return s.length <= 63 && DNS_LABEL.test(s);
}

/** A DNS-1035 label, as a Service name is: it starts with a letter. */
export function isDns1035Label(s: string): boolean {
  return s.length <= 63 && DNS_1035_LABEL.test(s);
}

function isPort(s: string): boolean {
  if (!/^\d+$/.test(s)) return false;
  const port = Number(s);
  return port >= 1 && port <= 65535;
}

function isProxyUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return PROXY_PROTOCOLS.includes(url.protocol) && url.hostname !== "";
}

export function validate(draft: SettingsDraft): DraftErrors {
  const errors: DraftErrors = {};
  const bad = splitNamespaces(draft.accessibleNamespaces).filter(
    (name) => !isDnsLabel(name),
  );
  if (bad.length > 0) {
    errors.accessibleNamespaces = `Not a namespace name: ${bad.join(", ")}`;
  }
  if (/\s/.test(draft.nodeShellImage.trim())) {
    errors.nodeShellImage = "An image reference, such as alpine:3.22";
  }
  const proxy = draft.proxyUrl.trim();
  if (proxy !== "" && !isProxyUrl(proxy)) errors.proxyUrl = PROXY_ERROR;
  if (draft.provider === "prometheus") {
    if (!isDnsLabel(draft.promNamespace.trim())) {
      errors.promNamespace = "A namespace name";
    }
    if (!isDns1035Label(draft.promService.trim())) {
      errors.promService = "A Service name";
    }
    if (!isPort(draft.promPort.trim())) {
      errors.promPort = "A port from 1 to 65535";
    }
  }
  return errors;
}

function textOrNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

function providerSetting(
  draft: SettingsDraft,
  saved: MetricsProviderSetting,
): MetricsProviderSetting {
  switch (draft.provider) {
    case "prometheus": {
      // scheme and pathPrefix have no field: a saved Prometheus keeps them.
      const kept = saved.kind === "prometheus" ? saved : null;
      return {
        kind: "prometheus",
        namespace: draft.promNamespace.trim(),
        service: draft.promService.trim(),
        port: Number(draft.promPort.trim()),
        scheme: kept?.scheme ?? null,
        pathPrefix: kept?.pathPrefix ?? null,
      };
    }
    case "auto":
      return { kind: "auto" };
    case "metricsServer":
      return { kind: "metricsServer" };
    case "none":
      return { kind: "none" };
  }
}

/** The settings to save: trimmed, with empty text as null. */
export function settingsFrom(
  draft: SettingsDraft,
  saved: ClusterSettings,
): ClusterSettings {
  return {
    displayName: textOrNull(draft.displayName),
    icon: draft.icon,
    defaultNamespace: draft.defaultNamespace,
    accessibleNamespaces: splitNamespaces(draft.accessibleNamespaces),
    terminalCwd: textOrNull(draft.terminalCwd),
    proxyUrl: textOrNull(draft.proxyUrl),
    nodeShellImage: textOrNull(draft.nodeShellImage),
    metricsProvider: providerSetting(draft, saved.metricsProvider),
  };
}

export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return (Object.keys(a) as (keyof SettingsDraft)[]).every(
    (key) => a[key] === b[key],
  );
}

/** What the Prometheus fields start with: the detected Prometheus, else the defaults. */
export function prometheusPrefill(
  detected: MetricsProvider | null | undefined,
): Pick<SettingsDraft, "promNamespace" | "promService" | "promPort"> {
  if (detected?.kind === "prometheus") {
    return {
      promNamespace: detected.namespace,
      promService: detected.service,
      promPort: String(detected.port),
    };
  }
  return { ...PROMETHEUS_DEFAULTS };
}

/** Why an icon file is refused, or null when it is a PNG or SVG of at most 256 KB. */
export function checkIconFile(file: {
  type: string;
  name: string;
  size: number;
}): string | null {
  const image =
    file.type === ""
      ? ICON_NAME.test(file.name)
      : ICON_TYPES.includes(file.type);
  return image && file.size <= ICON_MAX_BYTES ? null : ICON_ERROR;
}

export function statusText(
  errors: DraftErrors,
  changed: boolean,
  justSaved: boolean,
): string {
  if (Object.keys(errors).length > 0) {
    return "Fix the fields marked in red to save.";
  }
  if (changed) return "Unsaved changes.";
  if (justSaved) {
    return "Saved. Changes apply at once; the proxy applies on the next connect.";
  }
  return "";
}
