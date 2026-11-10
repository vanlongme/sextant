import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { resetHelmForTest, runKey, useHelm } from "../../stores/helm";
import {
  chart,
  chartVersion,
  detail,
  releaseList,
  runHandlers,
} from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { type FormMode, HelmFormScreen } from "./HelmFormScreen";

vi.mock("../editor/YamlEditor", () => ({
  YamlEditor: (props: {
    value: string;
    onChange(v: string): void;
    testId?: string;
  }) => (
    <textarea
      data-testid={props.testId}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

beforeEach(() => resetHelmForTest());
afterEach(() => vi.restoreAllMocks());

const INSTALL: FormMode = {
  kind: "install",
  repo: "bitnami",
  chart: "nginx",
  version: null,
};
const UPGRADE: FormMode = { kind: "upgrade", namespace: "shop", name: "web" };
const VERSIONS = [
  chartVersion({ version: "1.2.4", description: "Newer" }),
  chartVersion({ version: "1.2.3" }),
];

function Location() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

function backendFor(over: Parameters<typeof mockBackend>[0] = {}) {
  const runs = runHandlers();
  const backend = mockBackend({
    ...runs.handlers,
    ui_state_get: () => null,
    ui_state_set: () => null,
    helm_chart_search: () => ({
      charts: [
        chart({ name: "nginx", repo: "stable" }),
        chart({ name: "nginx" }),
        chart({ name: "redis" }),
      ],
      repoProblems: [],
    }),
    helm_chart_versions: () => VERSIONS,
    helm_chart_values: (args: { version: string }) =>
      `# defaults of ${args.version}\n`,
    helm_release_list: () => releaseList([]),
    helm_release_get: () => detail({ name: "web", chartVersion: "1.2.3" }),
    helm_release_values: () => "replicaCount: 2\n",
    session_stop: () => null,
    ...over,
  });
  return { backend, started: runs.started };
}

async function show(
  mode: FormMode,
  over: Parameters<typeof mockBackend>[0] = {},
) {
  const made = backendFor(over);
  const rendered = render(
    <MemoryRouter>
      <HelmFormScreen clusterId="c1" mode={mode} />
      <Location />
    </MemoryRouter>,
  );
  await act(flush);
  return { ...made, ...rendered };
}

const field = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const status = () => screen.getByTestId("helm-form-status").textContent;
const submit = () =>
  screen.getByTestId("helm-form-submit") as HTMLButtonElement;

async function pick(id: string, name: string) {
  fireEvent.keyDown(screen.getByTestId(id), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name }));
  await act(flush);
}

test("install starts with the latest version, its defaults, the chart name and default", async () => {
  await show(INSTALL);
  expect(screen.getByTestId("helm-form-title").textContent).toBe(
    "Install nginx",
  );
  expect(screen.getByText("Chart bitnami/nginx · Newer")).toBeTruthy();
  expect(screen.getByTestId("helm-form-version").textContent).toBe(
    "1.2.4 · app 1.25.0",
  );
  expect(field("helm-form-name").value).toBe("nginx");
  expect(field("helm-form-namespace").value).toBe("default");
  expect(field("helm-form-values").value).toBe("# defaults of 1.2.4\n");
  expect(screen.queryByTestId("helm-form-chart")).toBeNull();
  expect(status()).toBe(
    "Dry run renders the manifests on the server and changes nothing. Install streams helm's output here, and its errors verbatim.",
  );
  expect(submit().disabled).toBe(false);
});

test("install takes the version parameter and the single selected namespace", async () => {
  await show(
    { ...INSTALL, version: "1.2.3" },
    { ui_state_get: () => ["shop"] },
  );
  expect(screen.getByTestId("helm-form-version").textContent).toBe(
    "1.2.3 · app 1.25.0",
  );
  expect(field("helm-form-namespace").value).toBe("shop");
});

test("an empty name or namespace disables Dry run and Install", async () => {
  await show(INSTALL);
  fireEvent.change(field("helm-form-name"), { target: { value: " " } });
  expect(submit().disabled).toBe(true);
  expect(
    (screen.getByTestId("helm-form-dry-run") as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("a new version replaces values still as loaded, and keeps edited ones", async () => {
  await show(INSTALL);
  await pick("helm-form-version", "1.2.3 · app 1.25.0");
  expect(field("helm-form-values").value).toBe("# defaults of 1.2.3\n");
  fireEvent.change(field("helm-form-values"), {
    target: { value: "mine: true\n" },
  });
  await pick("helm-form-version", "1.2.4 · app 1.25.0");
  expect(field("helm-form-values").value).toBe("mine: true\n");
});

test("Dry run shows the manifest and the notes; a rejection shows Failed. with the message", async () => {
  let fail = false;
  const { backend } = await show(INSTALL, {
    helm_install_preview: () => {
      if (fail) {
        throw {
          code: "InvalidInput",
          message: "values: line 1, column 3: mapping values are not allowed",
          details: null,
        };
      }
      return {
        releaseName: "nginx",
        manifest: "kind: ConfigMap\n",
        notes: "Hi",
      };
    },
  });
  fireEvent.click(screen.getByTestId("helm-form-dry-run"));
  await act(flush);
  expect(backend.callsTo("helm_install_preview")).toEqual([
    {
      clusterId: "c1",
      request: {
        namespace: "default",
        releaseName: "nginx",
        chart: { repo: "bitnami", chart: "nginx", version: "1.2.4" },
        values: "# defaults of 1.2.4\n",
        createNamespace: false,
        wait: true,
      },
    },
  ]);
  expect(status()).toBe("Dry run finished; nothing was changed.");
  expect(screen.getByTestId("helm-form-preview-manifest").textContent).toBe(
    "kind: ConfigMap\n",
  );
  expect(screen.getByTestId("helm-form-preview-notes").textContent).toBe("Hi");

  fail = true;
  fireEvent.click(screen.getByTestId("helm-form-dry-run"));
  await act(flush);
  expect(status()).toBe("Failed.");
  expect(
    screen.getByText(
      "values: line 1, column 3: mapping values are not allowed",
    ),
  ).toBeTruthy();
});

test("an install streams its output and ends Installed. with a link to the release", async () => {
  const success = vi.spyOn(toast, "success");
  const { started } = await show(INSTALL);
  fireEvent.click(screen.getByTestId("helm-form-create-namespace"));
  fireEvent.click(submit());
  await act(flush);
  expect(started[0]?.args).toMatchObject({
    clusterId: "c1",
    request: { releaseName: "nginx", createNamespace: true, wait: true },
  });
  expect(status()).toBe("Installing");
  expect(submit().textContent).toBe("Installing");
  expect(submit().disabled).toBe(true);
  act(() => started[0]?.data("NAME: nginx\n"));
  const log = screen.getByRole("log", { name: "helm output" });
  expect(log.textContent).toBe("NAME: nginx\n");
  act(() => started[0]?.send({ type: "exited", code: 0 }));
  expect(status()).toBe("Installed.");
  // The page is open, so no toast.
  expect(success).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("helm-form-open-release"));
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/helm/releases?release=default%2Fnginx",
  );
});

test("a failed run points at the output and shows the error below it", async () => {
  const { started } = await show(INSTALL);
  fireEvent.click(submit());
  await act(flush);
  act(() =>
    started[0]?.send({
      type: "failed",
      error: {
        code: "Internal",
        message: "INSTALLATION FAILED: timed out",
        details: "context deadline exceeded",
      },
      podEvents: [],
    }),
  );
  expect(status()).toBe("Failed. helm wrote the error above.");
  expect(screen.getByText("INSTALLATION FAILED: timed out")).toBeTruthy();
  expect(screen.getByText("context deadline exceeded")).toBeTruthy();
});

test("Stop asks first, then stops the session; the run ends Stopped.", async () => {
  const { backend, started } = await show(INSTALL);
  fireEvent.click(submit());
  await act(flush);
  fireEvent.click(screen.getByTestId("helm-form-stop"));
  const dialog = await screen.findByTestId("helm-stop-dialog");
  expect(dialog.textContent).toContain(
    "helm stops where it is. nginx may be left failed, pending-install or pending-upgrade; roll it back or upgrade it again afterwards.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep running" }));
  expect(backend.callsTo("session_stop")).toEqual([]);
  fireEvent.click(screen.getByTestId("helm-form-stop"));
  fireEvent.click(
    within(await screen.findByTestId("helm-stop-dialog")).getByRole("button", {
      name: "Stop",
    }),
  );
  expect(backend.callsTo("session_stop")).toEqual([{ sessionId: "session-1" }]);
  act(() =>
    started[0]?.send({
      type: "failed",
      error: { code: "Cancelled", message: "stopped", details: null },
      podEvents: [],
    }),
  );
  expect(status()).toBe(
    "Stopped. nginx may be left failed or pending; check it in Releases.",
  );
});

test("upgrade starts with the release's version and values, and its first chart", async () => {
  await show(UPGRADE);
  expect(screen.getByTestId("helm-form-title").textContent).toBe("Upgrade web");
  expect(
    screen.getByText("Release in shop · chart bitnami/nginx · A web server"),
  ).toBeTruthy();
  expect(screen.getByTestId("helm-form-chart").textContent).toBe(
    "bitnami/nginx",
  );
  expect(screen.getByTestId("helm-form-version").textContent).toBe(
    "1.2.3 · app 1.25.0",
  );
  expect(field("helm-form-values").value).toBe("replicaCount: 2\n");
  expect(field("helm-form-name").disabled).toBe(true);
  expect(field("helm-form-namespace").disabled).toBe(true);
  expect(screen.queryByTestId("helm-form-create-namespace")).toBeNull();
});

test("the Chart select lists every repository with the chart, and a choice reads its versions", async () => {
  const { backend } = await show(UPGRADE);
  await pick("helm-form-chart", "stable/nginx");
  expect(backend.callsTo("helm_chart_versions")).toEqual([
    { repo: "bitnami", chart: "nginx" },
    { repo: "stable", chart: "nginx" },
  ]);
});

test("a chart in no repository, or a gone release, shows why and disables the actions", async () => {
  const first = await show(UPGRADE, {
    helm_release_get: () => detail({ name: "web", chartName: "unknown" }),
  });
  expect(screen.getByTestId("helm-form-missing").textContent).toBe(
    "The chart is not in any repository you have added.",
  );
  expect(submit().disabled).toBe(true);
  first.unmount();

  await show(UPGRADE, {
    helm_release_get: () => {
      throw { code: "NotFound", message: "not found", details: null };
    },
  });
  expect(screen.getByTestId("helm-form-missing").textContent).toBe(
    "The release shop/web is gone; it may have been uninstalled.",
  );
  expect(submit().disabled).toBe(true);
});

test("Upgrade asks first, then runs with the values on the page", async () => {
  const { started } = await show(UPGRADE);
  fireEvent.click(submit());
  const dialog = await screen.findByTestId("helm-upgrade-dialog");
  expect(dialog.textContent).toContain("Upgrade web?");
  expect(dialog.textContent).toContain(
    "helm upgrade applies bitnami/nginx 1.2.3 with the values on this page to web in shop. It runs with --wait, and the objects change as the new revision applies.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Upgrade" }));
  await act(flush);
  expect(started[0]?.args).toMatchObject({
    request: {
      namespace: "shop",
      release: "web",
      chart: { repo: "bitnami", chart: "nginx", version: "1.2.3" },
      values: "replicaCount: 2\n",
      wait: true,
    },
  });
  expect(status()).toBe("Upgrading");
});

test("leaving does not stop a run, and coming back shows it from the store", async () => {
  const success = vi.spyOn(toast, "success");
  const first = await show(UPGRADE);
  fireEvent.click(submit());
  fireEvent.click(
    within(await screen.findByTestId("helm-upgrade-dialog")).getByRole(
      "button",
      { name: "Upgrade" },
    ),
  );
  await act(flush);
  const { started } = first;
  first.unmount();
  act(() => started[0]?.data("progress\n"));
  expect(useHelm.getState().runs[runKey("c1", "shop", "web")]?.phase).toBe(
    "running",
  );

  render(
    <MemoryRouter>
      <HelmFormScreen clusterId="c1" mode={UPGRADE} />
    </MemoryRouter>,
  );
  await act(flush);
  expect(status()).toBe("Upgrading");
  expect(screen.getByRole("log").textContent).toBe("progress\n");
  act(() => started[0]?.send({ type: "exited", code: 0 }));
  expect(status()).toBe("Upgraded.");
  expect(success).not.toHaveBeenCalled();
});
