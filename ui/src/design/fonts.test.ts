import { expect, test } from "vitest";
import main from "../main.tsx?raw";

const WEIGHTS = ["400", "500", "600"];

test("main.tsx bundles both families in the three weights the design uses", () => {
  for (const family of ["manrope", "jetbrains-mono"]) {
    for (const weight of WEIGHTS) {
      expect(main).toContain(`import "@fontsource/${family}/${weight}.css";`);
    }
  }
});

test("no source file points at a font CDN", () => {
  const sources = import.meta.glob<string>("/src/**/*.{ts,tsx,css,html}", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  for (const [path, text] of Object.entries(sources)) {
    if (path.endsWith("fonts.test.ts")) continue;
    expect([path, /fonts\.(googleapis|gstatic)\.com/.test(text)]).toEqual([
      path,
      false,
    ]);
  }
});
