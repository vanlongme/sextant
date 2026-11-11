import { expect, test } from "vitest";
import type { ClusterSettings } from "../../ipc/generated/ClusterSettings";
import { clusterSettings, prometheus } from "../../test/metrics";
import {
  checkIconFile,
  draftFrom,
  emptyDraft,
  ICON_ERROR,
  ICON_MAX_BYTES,
  isDns1035Label,
  isDnsLabel,
  PROMETHEUS_DEFAULTS,
  prometheusPrefill,
  type SettingsDraft,
  sameDraft,
  settingsFrom,
  splitNamespaces,
  statusText,
  validate,
} from "./settingsForm";

const SAVED: ClusterSettings = clusterSettings({
  displayName: "Prod",
  icon: "data:image/png;base64,AAAA",
  defaultNamespace: "shop",
  accessibleNamespaces: ["shop", "default"],
  terminalCwd: "/srv/work",
  proxyUrl: "http://proxy.example:3128",
  nodeShellImage: "alpine:3.22",
  metricsProvider: { kind: "metricsServer" },
});

function draft(over: Partial<SettingsDraft> = {}): SettingsDraft {
  return { ...emptyDraft(), ...over };
}

test("a draft shows the saved settings as text, and saving it gives them back", () => {
  const d = draftFrom(SAVED);
  expect(d).toEqual({
    displayName: "Prod",
    icon: "data:image/png;base64,AAAA",
    defaultNamespace: "shop",
    accessibleNamespaces: "shop, default",
    terminalCwd: "/srv/work",
    nodeShellImage: "alpine:3.22",
    proxyUrl: "http://proxy.example:3128",
    provider: "metricsServer",
    promNamespace: "",
    promService: "",
    promPort: "",
  });
  expect(settingsFrom(d, SAVED)).toEqual(SAVED);
});

test("a saved Prometheus fills the three fields", () => {
  const d = draftFrom(
    clusterSettings({
      metricsProvider: {
        kind: "prometheus",
        namespace: "monitoring",
        service: "prometheus-server",
        port: 80,
        scheme: null,
        pathPrefix: null,
      },
    }),
  );
  expect([d.provider, d.promNamespace, d.promService, d.promPort]).toEqual([
    "prometheus",
    "monitoring",
    "prometheus-server",
    "80",
  ]);
});

test("empty and blank fields save null, and text is trimmed", () => {
  const out = settingsFrom(
    draft({
      displayName: "  ",
      terminalCwd: "",
      nodeShellImage: " alpine:3.22 ",
      proxyUrl: " ",
    }),
    SAVED,
  );
  expect(out.displayName).toBeNull();
  expect(out.terminalCwd).toBeNull();
  expect(out.nodeShellImage).toBe("alpine:3.22");
  expect(out.proxyUrl).toBeNull();
});

test("Restore defaults is an empty draft with no icon, no namespaces and Detect", () => {
  expect(emptyDraft()).toEqual({
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
  });
  expect(settingsFrom(emptyDraft(), SAVED)).toEqual(clusterSettings());
});

test("accessible namespaces split on commas and spaces, de-duplicate, and name every bad entry", () => {
  expect(splitNamespaces("shop, default  shop,,Bad_NS -x\n")).toEqual([
    "shop",
    "default",
    "Bad_NS",
    "-x",
  ]);
  expect(splitNamespaces(" , ")).toEqual([]);
  expect(
    validate(draft({ accessibleNamespaces: "shop, default  shop,,Bad_NS -x" }))
      .accessibleNamespaces,
  ).toBe("Not a namespace name: Bad_NS, -x");
  expect(
    validate(draft({ accessibleNamespaces: `shop ${"a".repeat(64)}` }))
      .accessibleNamespaces,
  ).toBe(`Not a namespace name: ${"a".repeat(64)}`);
  expect(
    validate(draft({ accessibleNamespaces: "shop,default" }))
      .accessibleNamespaces,
  ).toBeUndefined();
  expect(
    settingsFrom(draft({ accessibleNamespaces: "shop, default shop" }), SAVED)
      .accessibleNamespaces,
  ).toEqual(["shop", "default"]);
});

test("namespace and Service names follow DNS-1123 and DNS-1035 labels", () => {
  expect(isDnsLabel("a".repeat(63))).toBe(true);
  expect(isDnsLabel("a".repeat(64))).toBe(false);
  expect(isDnsLabel("9shop")).toBe(true);
  expect(isDnsLabel("Shop")).toBe(false);
  expect(isDnsLabel("shop-")).toBe(false);
  expect(isDnsLabel("")).toBe(false);
  expect(isDns1035Label("prometheus-server")).toBe(true);
  expect(isDns1035Label("9prometheus")).toBe(false);
  expect(isDns1035Label("a".repeat(64))).toBe(false);
});

test("a node shell image with whitespace inside is refused", () => {
  expect(
    validate(draft({ nodeShellImage: "alpine 3.22" })).nodeShellImage,
  ).toBe("An image reference, such as alpine:3.22");
  expect(
    validate(draft({ nodeShellImage: " alpine:3.22 " })).nodeShellImage,
  ).toBeUndefined();
  expect(
    validate(draft({ nodeShellImage: "" })).nodeShellImage,
  ).toBeUndefined();
});

test("a proxy with a user and password passes; a scheme-less or ftp proxy fails", () => {
  const error =
    "Use http://, https:// or socks5:// with a host and an optional port";
  const check = (proxyUrl: string) => validate(draft({ proxyUrl })).proxyUrl;
  expect(check("http://user:secret@proxy.example:3128")).toBeUndefined();
  expect(check("https://proxy.example")).toBeUndefined();
  expect(check("socks5://proxy.example:1080")).toBeUndefined();
  expect(check(" http://proxy.example:3128 ")).toBeUndefined();
  expect(check("")).toBeUndefined();
  expect(check("proxy.example:3128")).toBe(error);
  expect(check("ftp://proxy.example")).toBe(error);
  expect(check("http://")).toBe(error);
  expect(check("not a url")).toBe(error);
});

test("port 0 and 65536 fail, 1 and 65535 pass", () => {
  const port = (promPort: string) =>
    validate(
      draft({
        provider: "prometheus",
        promNamespace: "monitoring",
        promService: "prometheus-server",
        promPort,
      }),
    ).promPort;
  expect(port("0")).toBe("A port from 1 to 65535");
  expect(port("65536")).toBe("A port from 1 to 65535");
  expect(port("1")).toBeUndefined();
  expect(port("65535")).toBeUndefined();
  expect(port(" 9090 ")).toBeUndefined();
  expect(port("80a")).toBe("A port from 1 to 65535");
  expect(port("-1")).toBe("A port from 1 to 65535");
  expect(port("")).toBe("A port from 1 to 65535");
});

test("the Prometheus fields are checked only while Prometheus is picked", () => {
  const bad = { promNamespace: "Bad", promService: "9svc", promPort: "0" };
  expect(validate(draft({ provider: "prometheus", ...bad }))).toEqual({
    promNamespace: "A namespace name",
    promService: "A Service name",
    promPort: "A port from 1 to 65535",
  });
  expect(validate(draft({ provider: "auto", ...bad }))).toEqual({});
  expect(validate(emptyDraft())).toEqual({});
});

test("a saved Prometheus keeps its scheme and path prefix; a new one saves null for both", () => {
  const saved = clusterSettings({
    metricsProvider: {
      kind: "prometheus",
      namespace: "monitoring",
      service: "prometheus-server",
      port: 80,
      scheme: "https",
      pathPrefix: "/prom",
    },
  });
  const edited = { ...draftFrom(saved), promPort: "9091" };
  expect(settingsFrom(edited, saved).metricsProvider).toEqual({
    kind: "prometheus",
    namespace: "monitoring",
    service: "prometheus-server",
    port: 9091,
    scheme: "https",
    pathPrefix: "/prom",
  });
  const fresh = draft({
    provider: "prometheus",
    promNamespace: " observability ",
    promService: "prometheus-operated",
    promPort: "9090",
  });
  expect(settingsFrom(fresh, clusterSettings()).metricsProvider).toEqual({
    kind: "prometheus",
    namespace: "observability",
    service: "prometheus-operated",
    port: 9090,
    scheme: null,
    pathPrefix: null,
  });
});

test("the other providers save their kind alone", () => {
  for (const kind of ["auto", "metricsServer", "none"] as const) {
    expect(
      settingsFrom(draft({ provider: kind, promPort: "9090" }), SAVED)
        .metricsProvider,
    ).toEqual({ kind });
  }
});

test("the Prometheus prefill takes a detected Prometheus, else the defaults", () => {
  expect(
    prometheusPrefill(
      prometheus({ namespace: "mon", service: "prom", port: 9090 }),
    ),
  ).toEqual({ promNamespace: "mon", promService: "prom", promPort: "9090" });
  expect(
    prometheusPrefill({ kind: "metricsServer", chosenBy: "fallback" }),
  ).toEqual(PROMETHEUS_DEFAULTS);
  expect(prometheusPrefill(null)).toEqual({
    promNamespace: "observability",
    promService: "prometheus-operated",
    promPort: "9090",
  });
  expect(prometheusPrefill(undefined)).toEqual(PROMETHEUS_DEFAULTS);
});

test("an icon is a PNG or an SVG of at most 256 KB, by type or by name", () => {
  expect(ICON_MAX_BYTES).toBe(262_144);
  const file = (type: string, name: string, size: number) => ({
    type,
    name,
    size,
  });
  expect(checkIconFile(file("image/png", "a.png", 262_144))).toBeNull();
  expect(checkIconFile(file("image/svg+xml", "a.svg", 10))).toBeNull();
  expect(checkIconFile(file("", "a.SVG", 10))).toBeNull();
  expect(checkIconFile(file("", "a.png", 10))).toBeNull();
  expect(checkIconFile(file("image/png", "a.png", 262_145))).toBe(ICON_ERROR);
  expect(checkIconFile(file("image/jpeg", "a.png", 10))).toBe(ICON_ERROR);
  expect(checkIconFile(file("", "a.jpg", 10))).toBe(ICON_ERROR);
  expect(ICON_ERROR).toBe("Pick a PNG or SVG image up to 256 KB");
});

test("drafts are the same only when every field is", () => {
  expect(sameDraft(draftFrom(SAVED), draftFrom(SAVED))).toBe(true);
  const changes: Partial<SettingsDraft>[] = [
    { displayName: "x" },
    { icon: "x" },
    { defaultNamespace: "x" },
    { accessibleNamespaces: "x" },
    { terminalCwd: "x" },
    { nodeShellImage: "x" },
    { proxyUrl: "x" },
    { provider: "none" },
    { promNamespace: "x" },
    { promService: "x" },
    { promPort: "x" },
  ];
  // One change per field.
  expect(changes).toHaveLength(Object.keys(emptyDraft()).length);
  for (const change of changes) {
    expect([change, sameDraft(emptyDraft(), draft(change))]).toEqual([
      change,
      false,
    ]);
  }
});

test("the status says what blocks a save, then what is unsaved, then what was saved", () => {
  const errors = { proxyUrl: "bad" };
  expect(statusText(errors, true, true)).toBe(
    "Fix the fields marked in red to save.",
  );
  expect(statusText({}, true, true)).toBe("Unsaved changes.");
  expect(statusText({}, false, true)).toBe(
    "Saved. Changes apply at once; the proxy applies on the next connect.",
  );
  expect(statusText({}, false, false)).toBe("");
});
