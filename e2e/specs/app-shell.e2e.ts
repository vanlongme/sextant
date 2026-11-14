import fs from "node:fs";
import path from "node:path";
import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  expectConnected,
  expectResourceTitle,
  gone,
  pointerClick,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-palette";
const TARGET_ROW = `palette-object-configmaps-${NS}-palette-target`;
const MANIFEST = `apiVersion: v1
kind: ConfigMap
metadata:
  name: palette-target
  namespace: ${NS}
data:
  purpose: palette
`;
/** `skopos_core::VERSION` is the workspace version. */
const APP_VERSION =
  /^version = "([^"]+)"/m.exec(
    fs.readFileSync(path.resolve(__dirname, "..", "..", "Cargo.toml"), "utf8"),
  )?.[1] ?? "";

const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 30000, interval: 250, timeoutMsg });

async function openPalette(): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  await shown("palette-input");
}

/** Types the query, waits until the selected row's test id starts with `row`, and runs it. */
async function run(query: string, row: string): Promise<void> {
  await (await shown("palette-input")).setValue(query);
  await until(async () => {
    const selected = browser.$('[data-testid="palette"] [aria-selected="true"]');
    return (
      (await selected.isExisting()) &&
      ((await selected.getAttribute("data-testid")) ?? "").startsWith(row)
    );
  }, `the palette never selected ${row} for "${query}"`);
  await browser.keys("Enter");
  await gone("palette");
}

async function theme(): Promise<string | undefined> {
  return browser.execute(() => document.documentElement.dataset.theme);
}

describe("the application shell", () => {
  before(async () => {
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    if (APP_VERSION === "") throw new Error("no version in Cargo.toml");
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("opens the palette on the catalog and opens a cluster from it", async () => {
    await clickWhenShown("nav-catalog");
    await shown(`catalog-row-${KIND}`, 30000);
    await openPalette();
    await run(KIND, "palette-cluster-");
    await expectConnected();
    await shown("cluster-sidebar");
  });

  it("opens a list from Pages", async () => {
    await openPalette();
    await run("configmaps", "palette-page-r/core/configmaps");
    await expectResourceTitle("ConfigMap");
  });

  it("keeps the header on one line on the Resource map at the default window size", async () => {
    // Wrapping is for narrow windows (spec C §5); at the default 1360 px the title shrinks first.
    expect(await browser.execute(() => window.innerWidth)).toBeGreaterThanOrEqual(1300);
    await clickWhenShown("nav-map");
    await shown("map-ns-filter", 60000);
    const [title, disconnect, header] = await browser.execute(() =>
      ["header-title", "cluster-disconnect", "app-header"].map((id) => {
        const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
        return r ? { top: r.top, bottom: r.bottom, width: r.width } : null;
      }),
    );
    if (title === null || disconnect === null || header === null) {
      throw new Error("the header, its title or Disconnect is missing");
    }
    const middle = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2;
    expect(Math.abs(middle(disconnect) - middle(title))).toBeLessThan(4);
    expect(header.bottom - header.top).toBeLessThan(60);
    expect(title.width).toBeGreaterThan(100);
  });

  it("finds an object by name and opens its drawer", async () => {
    await openPalette();
    await (await shown("palette-input")).setValue("palette-target");
    const row = await shown(TARGET_ROW, 30000);
    expect(await row.getText()).toContain(`ConfigMap · ${NS}`);
    await run("palette-target", TARGET_ROW);
    await shown("detail-drawer");
  });

  it("sets the dark theme from a command", async () => {
    await openPalette();
    await run("theme dark", "palette-command-theme-dark");
    await until(async () => (await theme()) === "dark", "the theme never turned dark");
  });

  it("filters the Keyboard shortcuts dialog and closes it with Esc", async () => {
    await browser.keys(["Control", "/"]);
    await shown("shortcuts-dialog");
    await (await shown("shortcuts-filter")).setValue("palette");
    await shown("shortcut-palette");
    await gone("shortcut-back");
    await browser.keys("Escape");
    await gone("shortcuts-dialog");
  });

  it("shows About from the Help menu and copies the version info", async () => {
    await pointerClick(await shown("hotbar-help"));
    await clickWhenShown("help-about");
    await shown("about-dialog");
    expect(await byTestId("about-license").getText()).toBe("Apache-2.0");
    expect(await byTestId("about-version").getText()).toBe(APP_VERSION);
    await clickWhenShown("about-copy");
    const toast = await shown("toast");
    await until(
      async () => (await toast.getText()).includes("Version info copied"),
      "the copy toast never showed",
    );
    await clickWhenShown("about-close");
    await gone("about-dialog");
  });

  it("opens Preferences with Ctrl+,", async () => {
    await browser.keys(["Control", ","]);
    await until(
      async () => (await byTestId("header-title").getText()) === "Preferences",
      "Ctrl+, never opened Preferences",
    );
  });
});
