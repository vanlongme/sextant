import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetMetricsForTest, useMetrics } from "../../stores/metrics";
import { type Backend, clusterEntry, flush, mockBackend } from "../../test/ipc";
import { clusterSettings, prometheus } from "../../test/metrics";
import { CONNECTED } from "../../test/terminal";
import { ClusterSettingsRoute } from "./ClusterSettingsScreen";
import { keptDraft, resetDraftsForTest } from "./drafts";

beforeEach(() => {
  resetCatalogForTest();
  resetMetricsForTest();
  resetDraftsForTest();
});
afterEach(() => vi.restoreAllMocks());

const ICON = "data:image/png;base64,AAAA";

const FULL = clusterSettings({
  displayName: "Prod",
  icon: ICON,
  defaultNamespace: "shop",
  accessibleNamespaces: ["shop", "default"],
  terminalCwd: "/srv/work",
  proxyUrl: "http://proxy.example:3128",
  nodeShellImage: "alpine:3.22",
  metricsProvider: { kind: "metricsServer" },
});

const SAVED_PROMETHEUS = clusterSettings({
  metricsProvider: {
    kind: "prometheus",
    namespace: "monitoring",
    service: "prometheus-server",
    port: 80,
    scheme: "https",
    pathPrefix: "/prom",
  },
});

async function show(
  options: {
    saved?: ClusterSettings;
    state?: ConnectionState;
    handlers?: Parameters<typeof mockBackend>[0];
  } = {},
) {
  useCatalog.setState({
    loading: false,
    error: null,
    clusters: [
      clusterEntry({
        id: "id-x",
        name: "x",
        contextName: "kind-x",
        state: options.state ?? { status: "disconnected" },
      }),
    ],
  });
  const backend = mockBackend({
    cluster_settings_get: () => options.saved ?? clusterSettings(),
    cluster_settings_set: () => null,
    ...options.handlers,
  });
  render(
    <MemoryRouter initialEntries={["/cluster/id-x/settings"]}>
      <Routes>
        <Route
          path="/cluster/:id/settings"
          element={<ClusterSettingsRoute />}
        />
        <Route path="/cluster/:id" element={<p>overview page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const status = () => screen.getByTestId("settings-status").textContent;
const preview = () => screen.getByTestId("settings-icon-preview");
const radio = (kind: string) =>
  screen
    .getByTestId(`settings-metrics-${kind}`)
    .querySelector("input") as HTMLInputElement;
const PROM_FIELDS = [
  "settings-prom-namespace",
  "settings-prom-service",
  "settings-prom-port",
];
const promFields = () => PROM_FIELDS.map((id) => input(id).value);

function type(id: string, value: string): void {
  fireEvent.change(input(id), { target: { value } });
}

/** The error under a field, or null. */
function errorOf(id: string): string | null {
  return (
    input(id).parentElement?.querySelector('[role="alert"]')?.textContent ??
    null
  );
}

function pickProvider(kind: string): void {
  fireEvent.click(screen.getByTestId(`settings-metrics-${kind}`));
}

function chooseIcon(file: File): void {
  fireEvent.change(screen.getByTestId("settings-icon-file"), {
    target: { files: [file] },
  });
}

const png = (size: number) =>
  new File([new Uint8Array(size)], "icon.png", { type: "image/png" });

async function save(): Promise<void> {
  fireEvent.click(button("settings-save"));
  await act(flush);
}

/** The settings of the first save. */
function savedPayload(backend: Backend): ClusterSettings | undefined {
  return backend.callsTo("cluster_settings_set")[0]?.settings as
    | ClusterSettings
    | undefined;
}

test("the head names the cluster and its kubeconfig, and the fields show the saved settings", async () => {
  await show({ saved: FULL });
  expect(screen.getByTestId("settings-title").textContent).toBe(
    "Settings for x",
  );
  expect(screen.getByText(/^Context kind-x in /).textContent).toBe(
    "Context kind-x in /home/me/.kube/config. These settings stay in SkoposIDE; the kubeconfig file is not changed.",
  );
  expect(button("settings-back").textContent).toBe("Open x");
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual([
    "General",
    "Namespaces",
    "Terminal and node shell",
    "Network",
    "Metrics",
  ]);
  expect(input("settings-display-name").value).toBe("Prod");
  expect(input("settings-display-name").placeholder).toBe("kind-x");
  expect(preview().getAttribute("src")).toBe(ICON);
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "shop",
  );
  expect(input("settings-accessible-namespaces").value).toBe("shop, default");
  expect(input("settings-terminal-cwd").value).toBe("/srv/work");
  expect(input("settings-node-shell-image").value).toBe("alpine:3.22");
  expect(input("settings-proxy-url").value).toBe("http://proxy.example:3128");
  expect(radio("metricsServer").checked).toBe(true);
  expect(screen.queryByTestId("settings-prom-namespace")).toBeNull();
  expect(status()).toBe("");
  expect(button("settings-save").disabled).toBe(true);
  expect(button("settings-reset").disabled).toBe(true);
});

test("each field carries its label and help, and the provider options their descriptions", async () => {
  await show();
  const field = (id: string) => input(id).parentElement?.textContent;
  expect(field("settings-display-name")).toBe(
    "Display nameShown in the hotbar, the catalog and the title",
  );
  expect(field("settings-accessible-namespaces")).toBe(
    "Accessible namespacesComma separated. When set, SkoposIDE watches only these",
  );
  expect(field("settings-terminal-cwd")).toBe(
    "Terminal working directoryWhere the local terminal of this cluster starts",
  );
  expect(field("settings-node-shell-image")).toBe(
    "Node shell imageThe privileged Pod that enters a node",
  );
  expect(field("settings-proxy-url")).toBe(
    "Proxy URLFor this cluster's API server. Empty uses the kubeconfig's proxy-url, if it has one",
  );
  expect(screen.getByRole("combobox", { name: "Default namespace" })).toBe(
    screen.getByTestId("settings-default-namespace"),
  );
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "From the kubeconfig",
  );
  const group = screen.getByRole("group", { name: "Metrics provider" });
  expect(group).toBe(screen.getByTestId("settings-metrics"));
  expect(
    ["auto", "prometheus", "metricsServer", "none"].map(
      (k) => screen.getByTestId(`settings-metrics-${k}`).textContent,
    ),
  ).toEqual([
    "DetectLook for a Prometheus Service across namespaces, then fall back to metrics-server",
    "PrometheusA Service you name, queried through the API server proxy",
    "metrics-server onlyCurrent CPU and memory, no history",
    "NoneNo metrics for this cluster",
  ]);
  expect(radio("auto").checked).toBe(true);
  expect(preview().textContent).toBe("No icon");
  expect(screen.queryByTestId("settings-icon-remove")).toBeNull();
});

test("every field's error shows under it; Save stays disabled and the status says why", async () => {
  await show();
  type("settings-accessible-namespaces", "shop, Bad_NS");
  type("settings-node-shell-image", "alpine 3.22");
  type("settings-proxy-url", "ftp://proxy.example");
  pickProvider("prometheus");
  type("settings-prom-namespace", "Bad");
  type("settings-prom-service", "9svc");
  type("settings-prom-port", "0");
  expect(errorOf("settings-accessible-namespaces")).toBe(
    "Not a namespace name: Bad_NS",
  );
  expect(errorOf("settings-node-shell-image")).toBe(
    "An image reference, such as alpine:3.22",
  );
  expect(errorOf("settings-proxy-url")).toBe(
    "Use http://, https:// or socks5:// with a host and an optional port",
  );
  expect(errorOf("settings-prom-namespace")).toBe("A namespace name");
  expect(errorOf("settings-prom-service")).toBe("A Service name");
  expect(errorOf("settings-prom-port")).toBe("A port from 1 to 65535");
  expect(input("settings-prom-port").getAttribute("aria-invalid")).toBe("true");
  expect(errorOf("settings-display-name")).toBeNull();
  expect(status()).toBe("Fix the fields marked in red to save.");
  expect(button("settings-save").disabled).toBe(true);

  type("settings-prom-port", "9090");
  expect(errorOf("settings-prom-port")).toBeNull();
});

test("Save sends the trimmed settings, toasts with the proxy line, forgets the provider and says Saved", async () => {
  const success = vi.spyOn(toast, "success");
  useMetrics.setState({
    providers: { "id-x": { value: prometheus(), error: null, loading: false } },
  });
  const backend = await show();
  type("settings-display-name", " Prod ");
  type("settings-accessible-namespaces", "shop, default shop");
  type("settings-proxy-url", "http://proxy.example:3128");
  expect(status()).toBe("Unsaved changes.");
  expect(button("settings-save").disabled).toBe(false);
  expect(keptDraft("id-x")?.proxyUrl).toBe("http://proxy.example:3128");

  await save();

  expect(backend.callsTo("cluster_settings_set")).toEqual([
    {
      id: "id-x",
      settings: clusterSettings({
        displayName: "Prod",
        accessibleNamespaces: ["shop", "default"],
        proxyUrl: "http://proxy.example:3128",
      }),
    },
  ]);
  expect(success).toHaveBeenCalledWith(
    "Saved the settings for Prod",
    "Reconnect to use the new proxy.",
  );
  expect(useMetrics.getState().providers["id-x"]).toBeUndefined();
  expect(keptDraft("id-x")).toBeUndefined();
  expect(status()).toBe(
    "Saved. Changes apply at once; the proxy applies on the next connect.",
  );
  expect(button("settings-save").disabled).toBe(true);
  expect(input("settings-display-name").value).toBe("Prod");

  type("settings-terminal-cwd", "/srv");
  expect(status()).toBe("Unsaved changes.");
});

test("a save that keeps the proxy toasts without the reconnect line, under the context name", async () => {
  const success = vi.spyOn(toast, "success");
  await show();
  type("settings-terminal-cwd", "/srv/work");
  await save();
  expect(success).toHaveBeenCalledWith(
    "Saved the settings for kind-x",
    undefined,
  );
});

test("a saved Prometheus shows its fields in the mono font and keeps its scheme and path prefix", async () => {
  const backend = await show({ saved: SAVED_PROMETHEUS });
  expect(radio("prometheus").checked).toBe(true);
  expect(promFields()).toEqual(["monitoring", "prometheus-server", "80"]);
  for (const id of PROM_FIELDS) {
    expect([id, input(id).classList.contains("mono")]).toEqual([id, true]);
  }
  type("settings-prom-port", "9091");
  await save();
  expect(savedPayload(backend)?.metricsProvider).toEqual({
    kind: "prometheus",
    namespace: "monitoring",
    service: "prometheus-server",
    port: 9091,
    scheme: "https",
    pathPrefix: "/prom",
  });
});

test("picking Prometheus fills the fields from the detected Prometheus, without asking the backend", async () => {
  useMetrics.setState({
    providers: {
      "id-x": {
        value: prometheus({
          namespace: "mon",
          service: "prom-server",
          port: 9090,
        }),
        error: null,
        loading: false,
      },
    },
  });
  const backend = await show();
  pickProvider("prometheus");
  expect(promFields()).toEqual(["mon", "prom-server", "9090"]);
  expect(backend.callsTo("metrics_provider")).toEqual([]);
  await save();
  expect(savedPayload(backend)?.metricsProvider).toEqual({
    kind: "prometheus",
    namespace: "mon",
    service: "prom-server",
    port: 9090,
    scheme: null,
    pathPrefix: null,
  });
});

test("with no Prometheus detected, picking Prometheus fills the defaults, and typed fields stay", async () => {
  await show();
  pickProvider("prometheus");
  expect(promFields()).toEqual([
    "observability",
    "prometheus-operated",
    "9090",
  ]);
  type("settings-prom-service", "prom");
  pickProvider("auto");
  expect(screen.queryByTestId("settings-prom-namespace")).toBeNull();
  pickProvider("prometheus");
  expect(promFields()).toEqual(["observability", "prom", "9090"]);
});

test("Restore defaults empties the draft without saving; Reset brings the saved settings back", async () => {
  const backend = await show({ saved: FULL });
  fireEvent.click(button("settings-restore"));
  expect(
    [
      "settings-display-name",
      "settings-accessible-namespaces",
      "settings-terminal-cwd",
      "settings-node-shell-image",
      "settings-proxy-url",
    ].map((id) => input(id).value),
  ).toEqual(["", "", "", "", ""]);
  expect(radio("auto").checked).toBe(true);
  expect(preview().textContent).toBe("No icon");
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "From the kubeconfig",
  );
  expect(status()).toBe("Unsaved changes.");
  expect(backend.callsTo("cluster_settings_set")).toEqual([]);
  expect(keptDraft("id-x")?.provider).toBe("auto");

  fireEvent.click(button("settings-reset"));
  expect(keptDraft("id-x")).toBeUndefined();
  expect(input("settings-display-name").value).toBe("Prod");
  expect(input("settings-proxy-url").value).toBe("http://proxy.example:3128");
  expect(radio("metricsServer").checked).toBe(true);
  expect(preview().getAttribute("src")).toBe(ICON);
  expect(status()).toBe("");
  expect(button("settings-reset").disabled).toBe(true);
});

test("a failed save toasts the error and keeps the draft", async () => {
  const error = vi.spyOn(toast, "error");
  await show({
    handlers: {
      cluster_settings_set: () => {
        throw {
          code: "InvalidInput",
          message: "the proxy URL is not valid",
          details: null,
        };
      },
    },
  });
  type("settings-display-name", "Prod");
  await save();
  expect(error).toHaveBeenCalledWith(
    "Could not save the settings for x",
    "the proxy URL is not valid",
  );
  expect(input("settings-display-name").value).toBe("Prod");
  expect(status()).toBe("Unsaved changes.");
  expect(button("settings-save").disabled).toBe(false);
});

test("a failed read shows the error with Retry, and Retry reads again", async () => {
  let reads = 0;
  await show({
    handlers: {
      cluster_settings_get: () => {
        reads += 1;
        if (reads === 1) {
          throw {
            code: "Internal",
            message: "the settings file is unreadable",
            details: null,
          };
        }
        return clusterSettings({ displayName: "Prod" });
      },
    },
  });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Could not read the settings");
  expect(alert.textContent).toContain("the settings file is unreadable");
  expect(screen.queryByTestId("settings-save")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(reads).toBe(2);
  expect(input("settings-display-name").value).toBe("Prod");
});

test("an icon of 262145 bytes is refused, 262144 is taken", async () => {
  const backend = await show();
  chooseIcon(png(262_145));
  await act(flush);
  expect(screen.getByTestId("settings-icon-error").textContent).toBe(
    "Pick a PNG or SVG image up to 256 KB",
  );
  expect(preview().textContent).toBe("No icon");
  expect(button("settings-save").disabled).toBe(true);

  chooseIcon(png(262_144));
  await waitFor(() => expect(preview().tagName).toBe("IMG"));
  const src = preview().getAttribute("src") ?? "";
  expect(src.startsWith("data:image/png;base64,")).toBe(true);
  expect(screen.queryByTestId("settings-icon-error")).toBeNull();
  await save();
  expect(savedPayload(backend)?.icon).toBe(src);
});

test("Choose image opens the file picker; another type is refused, an SVG is taken, and Remove clears the icon", async () => {
  const backend = await show({ saved: clusterSettings({ icon: ICON }) });
  const file = screen.getByTestId("settings-icon-file") as HTMLInputElement;
  expect(file.accept).toBe("image/png,image/svg+xml");
  const click = vi.spyOn(file, "click");
  fireEvent.click(button("settings-icon-choose"));
  expect(click).toHaveBeenCalledTimes(1);

  chooseIcon(new File(["x"], "icon.jpg", { type: "image/jpeg" }));
  await act(flush);
  expect(screen.getByTestId("settings-icon-error").textContent).toBe(
    "Pick a PNG or SVG image up to 256 KB",
  );
  expect(preview().getAttribute("src")).toBe(ICON);

  chooseIcon(new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }));
  await waitFor(() =>
    expect(preview().getAttribute("src")).toBe(
      "data:image/svg+xml;base64,PHN2Zy8+",
    ),
  );

  fireEvent.click(button("settings-icon-remove"));
  expect(preview().textContent).toBe("No icon");
  expect(screen.queryByTestId("settings-icon-remove")).toBeNull();
  await save();
  expect(savedPayload(backend)?.icon).toBeNull();
});

test("the default namespace offers the kubeconfig, the cluster's namespaces and the saved one", async () => {
  const backend = await show({
    state: CONNECTED,
    saved: clusterSettings({ defaultNamespace: "legacy" }),
  });
  expect(button("settings-back").textContent).toBe("Back to x");
  expect(screen.getByTestId("settings-default-namespace").textContent).toBe(
    "legacy",
  );
  fireEvent.keyDown(screen.getByTestId("settings-default-namespace"), {
    key: "Enter",
  });
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "From the kubeconfig",
    "default",
    "shop",
    "legacy",
  ]);
  fireEvent.click(screen.getByRole("option", { name: "shop" }));
  await act(flush);
  await save();
  expect(savedPayload(backend)?.defaultNamespace).toBe("shop");
});

test("the back button opens the cluster's Overview", async () => {
  await show();
  fireEvent.click(button("settings-back"));
  expect(screen.getByText("overview page")).toBeTruthy();
});
