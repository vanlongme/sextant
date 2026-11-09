import { Terminal } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { PALETTE } from "../../design/palette";
import { FakeTermView } from "../../test/terminal";
import { createTermView, setTermViewFactory, xtermTheme } from "./termView";

afterEach(() => {
  setTermViewFactory(null);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test("createTermView makes an xterm view until a test swaps the factory, and null puts it back", () => {
  const fake = new FakeTermView();
  setTermViewFactory(() => fake);
  expect(createTermView()).toBe(fake);
  setTermViewFactory(null);
  const real = createTermView();
  expect(real).not.toBeInstanceOf(FakeTermView);
  expect(real.host.dataset.terminalHost).toBe("");
  real.dispose();
});

test.each(["light", "dark"] as const)(
  "the %s theme puts the palette's terminal block into xterm's theme",
  (theme) => {
    const colors = PALETTE[theme].terminal;
    expect(xtermTheme(colors)).toEqual({
      background: colors.background,
      foreground: colors.foreground,
      cursor: colors.cursor,
      cursorAccent: colors.background,
      selectionBackground: colors.selection,
      ...colors.ansi,
    });
  },
);

test("a write calls done once xterm has taken the bytes in", async () => {
  const view = createTermView();
  await new Promise<void>((resolve) =>
    view.write(new TextEncoder().encode("hello\r\n"), resolve),
  );
  view.dispose();
});

test("a note is plain text on its own line, dim for a note and red for an error", () => {
  const write = vi.spyOn(Terminal.prototype, "write");
  const view = createTermView();
  view.write(new TextEncoder().encode("$ "), () => {});
  view.writeNote("Pulling \u001b[31mimage\u001b[0m", "note");
  view.writeNote("Forbidden\u009b2J", "error");
  expect(write.mock.calls.slice(1).map((call) => call[0])).toEqual([
    "\r\n\u001b[0m\u001b[2mPulling [31mimage[0m\u001b[0m\r\n",
    "\u001b[0m\u001b[31mForbidden2J\u001b[0m\r\n",
  ]);
  view.dispose();
});

test("fit gives null while the host is outside the document or has no size, and dispose takes the host out", () => {
  const view = createTermView();
  expect(view.fit()).toBeNull();
  document.body.append(view.host);
  // jsdom lays nothing out, so the host has no size.
  expect(view.fit()).toBeNull();
  view.dispose();
  expect(view.host.isConnected).toBe(false);
});
