import { expect, test } from "vitest";
import { CSS_FILES, cssRules } from "../test/css";

// Stylesheets restyled so far. Each restyle task adds its files here.
const RESTYLED = [
  "/src/design/Button.module.css",
  "/src/design/IconButton.module.css",
  "/src/design/Input.module.css",
  "/src/design/Select.module.css",
  "/src/design/Tabs.module.css",
  "/src/design/Badge.module.css",
  "/src/design/StatusDot.module.css",
  "/src/design/Toast.module.css",
  "/src/design/Tooltip.module.css",
  "/src/design/Spinner.module.css",
  "/src/design/EmptyState.module.css",
  "/src/design/ErrorNotice.module.css",
  "/src/design/Dialog.module.css",
  "/src/design/ConfirmDialog.module.css",
  "/src/design/Menu.module.css",
  "/src/design/VirtualTable.module.css",
  "/src/design/DataTable.module.css",
];

const RING = /var\(--focus-ring\)|var\(--focus-ring-color\)|var\(--glow-/;

for (const path of RESTYLED) {
  const rules = cssRules(CSS_FILES[path] ?? "");

  test(`${path} exists`, () => {
    expect(CSS_FILES[path]).toBeDefined();
  });

  test(`${path}: focus draws a ring, never an outline`, () => {
    for (const r of rules.filter((x) => x.selector.includes(":focus"))) {
      const outline = r.decls.find(([p]) => p === "outline");
      if (outline)
        expect([r.selector, outline[1]]).toEqual([r.selector, "none"]);
      const shadow = r.decls.find(([p]) => p === "box-shadow");
      expect([r.selector, RING.test(shadow?.[1] ?? "")]).toEqual([
        r.selector,
        true,
      ]);
    }
  });

  test(`${path}: hover never changes opacity`, () => {
    for (const r of rules.filter((x) => x.selector.includes(":hover"))) {
      expect([r.selector, r.decls.some(([p]) => p === "opacity")]).toEqual([
        r.selector,
        false,
      ]);
    }
  });

  test(`${path}: radii, shadows and motion come from tokens`, () => {
    for (const r of rules) {
      for (const [prop, value] of r.decls) {
        const where = `${r.selector} { ${prop}: ${value} }`;
        if (prop === "border-radius") {
          // Every corner is a radius token, 0 or 50%.
          for (const corner of value.split(/\s+/)) {
            expect([where, corner]).toEqual([
              where,
              expect.stringMatching(/^(var\(--radius-[a-z]+\)|0|50%)$/),
            ]);
          }
        }
        if (prop === "box-shadow" && value !== "none") {
          expect(where).toMatch(/var\(--(shadow-|focus-ring|glow-)/);
        }
        if (prop === "transition" || prop === "animation") {
          expect(where).toMatch(/var\(--(dur-|transition-)|: none/);
        }
        if (prop === "backdrop-filter") {
          expect(path).toBe("/src/design/Dialog.module.css");
        }
      }
    }
  });
}

test("controls use the design system's heights", () => {
  const height = (path: string, selector: string) =>
    cssRules(CSS_FILES[path])
      .find((r) => r.selector === selector)
      ?.decls.find(([p]) => p === "height")?.[1];
  expect(height("/src/design/Button.module.css", ".md")).toBe(
    "var(--control-md)",
  );
  expect(height("/src/design/Button.module.css", ".sm")).toBe(
    "var(--control-sm)",
  );
  expect(height("/src/design/IconButton.module.css", ".button")).toBe(
    "var(--control-sm)",
  );
  expect(height("/src/design/Input.module.css", ".input")).toBe(
    "var(--control-sm)",
  );
  expect(height("/src/design/Select.module.css", ".trigger")).toBe(
    "var(--control-sm)",
  );
  // Fields are 30 px in toolbars and 36 px in dialogs and forms (spec §5).
  const tall = ':where([role="dialog"], [role="alertdialog"], form)';
  expect(height("/src/design/Input.module.css", `${tall} .input`)).toBe(
    "var(--control-md)",
  );
  expect(height("/src/design/Select.module.css", `${tall} .trigger`)).toBe(
    "var(--control-md)",
  );
});

test("badges read a state on a soft pill, and toasts and tooltips enter without an exit animation", () => {
  const badge = cssRules(CSS_FILES["/src/design/Badge.module.css"]);
  const tone = (s: string) =>
    Object.fromEntries(badge.find((r) => r.selector === s)?.decls ?? []);
  expect(tone(".ok")).toEqual({
    background: "var(--status-nominal-soft)",
    color: "var(--status-nominal-text)",
  });
  expect(tone(".warn").color).toBe("var(--status-warning-text)");
  expect(tone(".danger").color).toBe("var(--status-critical-text)");
  expect(tone(".info").color).toBe("var(--text-on-accent-soft)");
  for (const file of ["Toast", "Tooltip"]) {
    const css = CSS_FILES[`/src/design/${file}.module.css`];
    expect(css).not.toMatch(/data-state="closed"[^{]*\{[^}]*animation/);
  }
});

test("dialogs sit on a blurred scrim with the deepest shadow and no exit animation", () => {
  const dialog = cssRules(CSS_FILES["/src/design/Dialog.module.css"]);
  const decls = (s: string) =>
    Object.fromEntries(dialog.find((r) => r.selector === s)?.decls ?? []);
  expect(decls(".overlay").background).toBe("var(--scrim)");
  expect(decls(".overlay")["backdrop-filter"]).toBe("var(--blur-thin)");
  expect(decls(".content")["box-shadow"]).toBe("var(--shadow-4)");
  expect(decls(".content")["border-radius"]).toBe("var(--radius-xl)");
  expect(CSS_FILES["/src/design/Dialog.module.css"]).not.toMatch(
    /data-state="closed"[^{]*\{[^}]*animation/,
  );
  const menu = cssRules(CSS_FILES["/src/design/Menu.module.css"]);
  const content = Object.fromEntries(
    menu.find((r) => r.selector === ".content")?.decls ?? [],
  );
  expect(content["box-shadow"]).toBe("var(--shadow-3)");
  expect(content["border-radius"]).toBe("var(--radius-md)");
});

test("tables have hairline rows, no outer border and an inset focus ring", () => {
  const vt = cssRules(CSS_FILES["/src/design/VirtualTable.module.css"]);
  const decls = (s: string) =>
    Object.fromEntries(vt.find((r) => r.selector === s)?.decls ?? []);
  expect(decls(".scroller").border).toBeUndefined();
  expect(decls(".bodyRow")["border-bottom"]).toBe("1px solid var(--divider)");
  expect(decls(".selected").background).toBe("var(--surface-selected)");
  expect(decls(".clickable:focus-visible")["box-shadow"]).toBe(
    "inset 0 0 0 2px var(--focus-ring-color)",
  );
});
