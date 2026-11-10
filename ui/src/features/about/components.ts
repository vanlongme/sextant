/** One row of About's "Open-source components" table (spec C §8.3). */
export interface ComponentRow {
  name: string;
  version: string;
  license: string;
}

/** `2.12` from `2.12.5`, `v4.3.1` → `4.3`, `^3.14.26` → `3.14`. */
export function majorMinor(version: string): string {
  const match = /(\d+)\.(\d+)/.exec(version);
  return match === null ? version : `${match[1]}.${match[2]}`;
}

/**
 * Bundled libraries as major.minor literals. `components.test.ts` compares them
 * with `Cargo.lock` and `ui/package.json`, so an upgrade that forgets this list
 * fails the tests.
 */
export const BUNDLED: readonly ComponentRow[] = [
  { name: "Tauri", version: "2.12", license: "Apache-2.0 OR MIT" },
  { name: "kube", version: "5.0", license: "Apache-2.0" },
  { name: "k8s-openapi", version: "0.29", license: "Apache-2.0" },
  { name: "portable-pty", version: "0.9", license: "MIT" },
  { name: "serde_json", version: "1.0", license: "MIT OR Apache-2.0" },
  { name: "React", version: "19.3", license: "MIT" },
  { name: "react-router", version: "8.5", license: "MIT" },
  { name: "zustand", version: "5.0", license: "MIT" },
  { name: "Radix UI primitives", version: "1.x, 2.x", license: "MIT" },
  { name: "TanStack Virtual", version: "3.14", license: "MIT" },
  { name: "Monaco Editor", version: "0.57", license: "MIT" },
  { name: "xterm.js", version: "6.0", license: "MIT" },
];

/** The bundled libraries, then helm and kubectl at the versions `app_info` pins. */
export function components(
  tools: { helm: string; kubectl: string } | null,
): ComponentRow[] {
  return [
    ...BUNDLED,
    {
      name: "helm (managed download)",
      version: tools === null ? "unknown" : majorMinor(tools.helm),
      license: "Apache-2.0",
    },
    {
      name: "kubectl (managed download)",
      version: tools === null ? "unknown" : majorMinor(tools.kubectl),
      license: "Apache-2.0",
    },
  ];
}
