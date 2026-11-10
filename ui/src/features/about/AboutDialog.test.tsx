import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { copyText } from "../../design/clipboard";
import type { AppInfo } from "../../ipc/generated/AppInfo";
import { resetShellForTest, useShell } from "../../stores/shell";
import { mockBackend } from "../../test/ipc";
import { AboutDialog, aboutFacts } from "./AboutDialog";

vi.mock("../../design/clipboard", () => ({ copyText: vi.fn() }));

const INFO: AppInfo = {
  version: "0.1.0",
  commit: "abc1234",
  commitDate: "2026-11-10",
  tauri: "2.12.5",
  webview: "WebKitGTK",
  webviewVersion: "2.50.1",
  platform: "Linux",
  helm: "v4.3.1",
  kubectl: "v1.37.2",
};

const LINES = [
  "SkoposIDE 0.1.0 (abc1234, 2026-11-10)",
  "Tauri 2.12.5 on WebKitGTK 2.50.1",
  "Linux",
];

async function show(appInfo: () => unknown): Promise<void> {
  mockBackend({ app_info: appInfo });
  render(<AboutDialog />);
  act(() => useShell.getState().open("about"));
  await screen.findByRole("dialog", { name: "About SkoposIDE" });
}

function fact(id: string): string {
  return screen.getByTestId(`about-${id}`).textContent ?? "";
}

beforeEach(() => {
  resetShellForTest();
});

test("the facts come from app_info", async () => {
  await show(() => INFO);

  expect(await screen.findByTestId("about-version")).toBeTruthy();
  expect(
    ["version", "build", "runtime", "platform", "license"].map(fact),
  ).toEqual([
    "0.1.0",
    "abc1234 · 2026-11-10",
    "Tauri 2.12.5 · WebKitGTK 2.50.1",
    "Linux",
    "Apache-2.0",
  ]);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "SkoposIDE",
  );
  expect(
    screen.getByText("Open-source desktop Kubernetes IDE · Version 0.1.0"),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Notices for code adapted from other open-source projects are in THIRD_PARTY_NOTICES.md, installed with the app.",
    ),
  ).toBeTruthy();
  const table = screen.getByTestId("about-components");
  expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual(
    ["Component", "Version", "License"],
  );
  const rows = [...table.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent),
  );
  expect(rows).toHaveLength(14);
  expect(rows[0]).toEqual(["Tauri", "2.12", "Apache-2.0 OR MIT"]);
  expect(rows.slice(-2)).toEqual([
    ["helm (managed download)", "4.3", "Apache-2.0"],
    ["kubectl (managed download)", "1.37", "Apache-2.0"],
  ]);
});

test("when app_info fails, Build, Runtime and Platform read unknown and the version comes from getVersion", async () => {
  await show(() => {
    throw { code: "Internal", message: "no facts", details: null };
  });

  await waitFor(() => expect(fact("version")).toBe("0.1.0"));
  expect(["build", "runtime", "platform", "license"].map(fact)).toEqual([
    "unknown",
    "unknown",
    "unknown",
    "Apache-2.0",
  ]);
});

test("Copy version info writes three lines and toasts them joined", async () => {
  const success = vi.spyOn(toast, "success");
  await show(() => INFO);
  const copy = await screen.findByTestId("about-copy");
  await waitFor(() => expect(copy.hasAttribute("disabled")).toBe(false));
  expect(copy.textContent).toBe("Copy version info");

  fireEvent.click(copy);

  await waitFor(() =>
    expect(success).toHaveBeenCalledWith(
      "Version info copied",
      LINES.join(" · "),
    ),
  );
  expect(copyText).toHaveBeenCalledWith(LINES.join("\n"));
});

test("a failed copy shows the danger toast", async () => {
  const error = vi.spyOn(toast, "error");
  vi.mocked(copyText).mockRejectedValueOnce(new Error("no clipboard"));
  await show(() => INFO);
  const copy = await screen.findByTestId("about-copy");
  await waitFor(() => expect(copy.hasAttribute("disabled")).toBe(false));

  fireEvent.click(copy);

  await waitFor(() =>
    expect(error).toHaveBeenCalledWith("Could not copy the version info"),
  );
});

test("Close and the X button close About", async () => {
  await show(() => INFO);

  fireEvent.click(await screen.findByTestId("about-close"));
  await waitFor(() => expect(screen.queryByTestId("about-dialog")).toBeNull());
  expect(useShell.getState().dialog).toBeNull();

  act(() => useShell.getState().open("about"));
  const dialog = await screen.findByTestId("about-dialog");
  const [x] = [...dialog.querySelectorAll("button")].filter(
    (b) => b.getAttribute("aria-label") === "Close",
  );
  fireEvent.click(x);
  await waitFor(() => expect(screen.queryByTestId("about-dialog")).toBeNull());
});

test("the copy text without a commit, and after app_info failed", () => {
  const noCommit = { ...INFO, commit: null, commitDate: null };
  expect(aboutFacts(noCommit, "0.1.0").lines).toEqual([
    "SkoposIDE 0.1.0 (unknown build)",
    "Tauri 2.12.5 on WebKitGTK 2.50.1",
    "Linux",
  ]);
  expect(aboutFacts(noCommit, "0.1.0").build).toBe("unknown");
  expect(aboutFacts({ ...INFO, webviewVersion: null }, "0.1.0").runtime).toBe(
    "Tauri 2.12.5 · WebKitGTK unknown",
  );
  expect(aboutFacts(null, "0.1.0").lines).toEqual([
    "SkoposIDE 0.1.0 (unknown build)",
    "Tauri unknown",
    "unknown",
  ]);
});
