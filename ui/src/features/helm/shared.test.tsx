import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { resetHelmForTest } from "../../stores/helm";
import { toolStatus } from "../../test/helm";
import { emitEvent, flush, mockBackend } from "../../test/ipc";
import { CodeBlock } from "./CodeBlock";
import { DrawerFrame } from "./DrawerFrame";
import { HelmMissing } from "./HelmMissing";
import { Notice } from "./Notice";

beforeEach(() => resetHelmForTest());

const MISSING = toolStatus({
  tool: "helm",
  source: "missing",
  path: null,
  version: null,
});
const KUBECTL = toolStatus({ tool: "kubectl" });

test("a notice is an alert unless it is neutral", () => {
  render(
    <>
      <Notice tone="warn" testId="w">
        Careful
      </Notice>
      <Notice tone="neutral" testId="n">
        For your information
      </Notice>
    </>,
  );
  expect(screen.getByTestId("w").getAttribute("role")).toBe("alert");
  expect(screen.getByTestId("n").getAttribute("role")).toBe("status");
});

test("a code block shows its title, its text and a Copy button named after it", () => {
  render(<CodeBlock title="Default values" text={"a: 1\n"} testId="code" />);
  expect(screen.getByRole("heading", { name: "Default values" })).toBeTruthy();
  expect(screen.getByTestId("code").textContent).toBe("a: 1\n");
  expect(
    screen.getByRole("button", { name: "Copy default values" }),
  ).toBeTruthy();
});

test("the drawer frame takes focus, gives it back, and closes on Escape or Close", () => {
  const onClose = vi.fn();
  const { unmount } = render(
    <>
      <button type="button">before</button>
      <DrawerFrame
        label="Chart details"
        testId="frame"
        title="nginx"
        kind="Helm chart in bitnami"
        onClose={onClose}
      >
        <p>body</p>
      </DrawerFrame>
    </>,
  );
  expect(document.activeElement).toBe(screen.getByTestId("frame"));
  fireEvent.keyDown(screen.getByText("body"), { key: "Escape" });
  fireEvent.click(screen.getByTestId("frame-close"));
  expect(onClose).toHaveBeenCalledTimes(2);
  unmount();
});

function showMissing(onReady = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/cluster/c1/helm/charts"]}>
      <Routes>
        <Route
          path="/cluster/c1/helm/charts"
          element={
            <HelmMissing
              message="helm is not on PATH and no path is set"
              onReady={onReady}
            />
          }
        />
        <Route path="/preferences" element={<p>Preferences page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return onReady;
}

test("missing helm offers its download, shows the progress, and reloads the screen when done", async () => {
  let statuses = [MISSING, KUBECTL];
  const backend = mockBackend({
    tools_status: () => statuses,
    tools_download: () => new Promise(() => {}),
    tools_download_cancel: () => null,
  });
  const onReady = showMissing();
  expect(await screen.findByText("helm is not available")).toBeTruthy();
  expect(
    screen.getByText("helm is not on PATH and no path is set"),
  ).toBeTruthy();
  fireEvent.click(await screen.findByTestId("helm-download"));
  expect(backend.callsTo("tools_download")).toEqual([{ tool: "helm" }]);

  await emitEvent("tools://progress", {
    tool: "helm",
    phase: "downloading",
    receivedBytes: 50,
    totalBytes: 100,
    error: null,
  });
  expect(
    screen.getByTestId("helm-download-progress").getAttribute("aria-valuenow"),
  ).toBe("50");
  expect(screen.getByText("Downloading helm v4.3.1 · 50%")).toBeTruthy();
  fireEvent.click(screen.getByTestId("helm-download-cancel"));
  expect(backend.callsTo("tools_download_cancel")).toEqual([{ tool: "helm" }]);

  statuses = [toolStatus({ tool: "helm", source: "managed" }), KUBECTL];
  await emitEvent("tools://progress", {
    tool: "helm",
    phase: "done",
    receivedBytes: 100,
    totalBytes: 100,
    error: null,
  });
  await flush();
  expect(onReady).toHaveBeenCalledTimes(1);
});

test("a Preferences path with a problem shows it and opens Preferences, with no download", async () => {
  mockBackend({
    tools_status: () => [
      toolStatus({
        tool: "helm",
        source: "preferences",
        path: "/opt/helm",
        problem: "/opt/helm is not executable",
      }),
      KUBECTL,
    ],
  });
  showMissing();
  expect(await screen.findByText("/opt/helm is not executable")).toBeTruthy();
  expect(screen.queryByTestId("helm-download")).toBeNull();
  fireEvent.click(screen.getByTestId("helm-open-prefs"));
  expect(await screen.findByText("Preferences page")).toBeTruthy();
});
