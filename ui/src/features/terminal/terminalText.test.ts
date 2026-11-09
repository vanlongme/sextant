import { expect, test } from "vitest";
import { noteLine, stripControls } from "./terminalText";

test("stripControls drops every C0 and C1 control, ESC included, and keeps the text", () => {
  expect(stripControls("\u001b[31mred\u001b[0m \u0007bell\u0000")).toBe(
    "[31mred[0m bell",
  );
  expect(stripControls("csi\u009b2Jdone\u007f")).toBe("csi2Jdone");
  expect(stripControls("Ünïcode · ok …")).toBe("Ünïcode · ok …");
});

test("a run of line breaks and tabs becomes one space, so a note stays on its line", () => {
  expect(stripControls("first\r\nsecond\tthird\n\nfourth")).toBe(
    "first second third fourth",
  );
});

test("a note line resets the style, is dim, ends its line, and carries no escape from its text", () => {
  expect(noteLine("Pulling \u001b]0;title\u0007image", "note")).toBe(
    "\u001b[0m\u001b[2mPulling ]0;titleimage\u001b[0m\r\n",
  );
});

test("an error line is in the theme's red", () => {
  expect(noteLine("Forbidden", "error")).toBe(
    "\u001b[0m\u001b[31mForbidden\u001b[0m\r\n",
  );
});
