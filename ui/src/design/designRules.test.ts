import { expect, test } from "vitest";
import { CSS_FILES, cssRules, themeTokens } from "../test/css";

// Every stylesheet but the vendored tokens and the base layer.
const RESTYLED = Object.keys(CSS_FILES).filter(
  (p) => !p.endsWith("/tinyorbit.css") && !p.endsWith("/global.css"),
);

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

test("switches show the accent when on and the focus ring on the track", () => {
  const decl = (selector: string, prop: string) =>
    cssRules(CSS_FILES["/src/design/Switch.module.css"] ?? "")
      .find((r) => r.selector === selector)
      ?.decls.find(([p]) => p === prop)?.[1];
  expect(decl(".input:checked + .track", "background")).toBe(
    "var(--surface-accent)",
  );
  expect(decl(".input:focus-visible + .track", "box-shadow")).toBe(
    "var(--focus-ring)",
  );
  expect(decl(".sm .track", "height")).toBe("16px");
  expect(decl(".md .track", "height")).toBe("18px");
});

/** `cssRules` keeps line breaks inside selectors and values. */
const norm = (s: string) =>
  s.replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s\)/g, ")");

test("sticky cells paint an opaque base under their tint, in every row state and both themes", () => {
  const vt = cssRules(CSS_FILES["/src/design/VirtualTable.module.css"]);
  const sticky = vt.filter((r) => r.selector.includes(".stickyEnd"));
  expect(sticky.map((r) => norm(r.selector))).toEqual([
    ".stickyEnd",
    ".bodyRow:hover .stickyEnd",
    ".bodyRow.selected .stickyEnd, .bodyRow.active .stickyEnd, .bodyRow.selected:hover .stickyEnd, .bodyRow.active:hover .stickyEnd",
  ]);
  const tints = [undefined, "var(--surface-hover)", "var(--surface-selected)"];
  sticky.forEach((r, i) => {
    const decls = Object.fromEntries(r.decls.map(([p, v]) => [p, norm(v)]));
    expect([r.selector, decls.background]).toEqual([r.selector, undefined]);
    expect([r.selector, decls["background-color"]]).toEqual([
      r.selector,
      "var(--surface-card)",
    ]);
    const tint = tints[i];
    expect([r.selector, decls["background-image"]]).toEqual([
      r.selector,
      tint === undefined ? undefined : `linear-gradient(${tint}, ${tint})`,
    ]);
  });
  for (const theme of ["light", "dark"] as const) {
    expect([theme, themeTokens(theme).get("--surface-card")]).toEqual([
      theme,
      expect.stringMatching(/^#[0-9a-f]{6}$/i),
    ]);
  }
});

test("cells clip links, buttons and badges with an ellipsis", () => {
  const vt = cssRules(CSS_FILES["/src/design/VirtualTable.module.css"]);
  const inner = Object.fromEntries(
    vt.find((r) => norm(r.selector) === ".cell > a, .cell > button")?.decls ??
      [],
  );
  expect(inner).toMatchObject({
    "max-width": "100%",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  });
  const badge = cssRules(CSS_FILES["/src/design/Badge.module.css"]);
  const decls = (s: string) =>
    Object.fromEntries(badge.find((r) => r.selector === s)?.decls ?? []);
  expect(decls(".badge")["max-width"]).toBe("100%");
  expect(decls(".label")).toMatchObject({
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  });
});
