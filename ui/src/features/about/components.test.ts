import { expect, test } from "vitest";
import cargoLock from "../../../../Cargo.lock?raw";
import packageJson from "../../../package.json?raw";
import { BUNDLED, components, majorMinor } from "./components";

const manifest = JSON.parse(packageJson) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const PACKAGES: Record<string, string> = {
  ...manifest.dependencies,
  ...manifest.devDependencies,
};

function crate(name: string): string {
  const match = new RegExp(`\\nname = "${name}"\\nversion = "([^"]+)"`).exec(
    cargoLock,
  );
  if (match === null) throw new Error(`${name} is not in Cargo.lock`);
  return majorMinor(match[1]);
}

function npm(name: string): string {
  const range = PACKAGES[name];
  if (range === undefined) throw new Error(`${name} is not in ui/package.json`);
  return majorMinor(range);
}

/** The distinct majors of the `@radix-ui/*` packages, as `1.x, 2.x`. */
function radixMajors(): string {
  const majors = new Set<number>();
  for (const [name, range] of Object.entries(PACKAGES)) {
    const major = /\d+/.exec(range)?.[0];
    if (name.startsWith("@radix-ui/") && major !== undefined) {
      majors.add(Number(major));
    }
  }
  return [...majors]
    .sort((a, b) => a - b)
    .map((m) => `${m}.x`)
    .join(", ");
}

/** Where each literal's version comes from (spec C §8.3). */
const SOURCES: Record<string, () => string> = {
  Tauri: () => crate("tauri"),
  kube: () => crate("kube"),
  "k8s-openapi": () => crate("k8s-openapi"),
  "portable-pty": () => crate("portable-pty"),
  serde_json: () => crate("serde_json"),
  React: () => npm("react"),
  "react-router": () => npm("react-router"),
  zustand: () => npm("zustand"),
  "Radix UI primitives": radixMajors,
  "TanStack Virtual": () => npm("@tanstack/react-virtual"),
  "Monaco Editor": () => npm("monaco-editor"),
  "xterm.js": () => npm("@xterm/xterm"),
};

test("the list follows the spec's order and licenses", () => {
  expect(components(null).map((c) => [c.name, c.license])).toEqual([
    ["Tauri", "Apache-2.0 OR MIT"],
    ["kube", "Apache-2.0"],
    ["k8s-openapi", "Apache-2.0"],
    ["portable-pty", "MIT"],
    ["serde_json", "MIT OR Apache-2.0"],
    ["React", "MIT"],
    ["react-router", "MIT"],
    ["zustand", "MIT"],
    ["Radix UI primitives", "MIT"],
    ["TanStack Virtual", "MIT"],
    ["Monaco Editor", "MIT"],
    ["xterm.js", "MIT"],
    ["helm (managed download)", "Apache-2.0"],
    ["kubectl (managed download)", "Apache-2.0"],
  ]);
});

test("each version literal matches Cargo.lock or ui/package.json", () => {
  expect(BUNDLED.map((c) => c.name)).toEqual(Object.keys(SOURCES));
  for (const component of BUNDLED) {
    expect([component.name, component.version]).toEqual([
      component.name,
      SOURCES[component.name]?.(),
    ]);
  }
});

test("helm and kubectl show the pinned versions as major.minor", () => {
  const tools = { helm: "v4.3.1", kubectl: "v1.37.2" };
  expect(
    components(tools)
      .slice(-2)
      .map((c) => c.version),
  ).toEqual(["4.3", "1.37"]);
  expect(
    components(null)
      .slice(-2)
      .map((c) => c.version),
  ).toEqual(["unknown", "unknown"]);
});

test("majorMinor drops the patch, a leading v and a range prefix", () => {
  expect(
    ["2.12.5", "v4.3.1", "^3.14.26", "~0.57.0", "1.0.154"].map(majorMinor),
  ).toEqual(["2.12", "4.3", "3.14", "0.57", "1.0"]);
});

test("the list names libraries only, with no address", () => {
  expect(JSON.stringify(components(null))).not.toMatch(/https?:|www\./);
});
