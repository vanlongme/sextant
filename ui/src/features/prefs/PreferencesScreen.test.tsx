import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { Toaster } from "../../design";
import type { Prefs } from "../../ipc/generated/Prefs";
import { resetPrefsForTest, usePrefs } from "../../stores/prefs";
import { mockBackend } from "../../test/ipc";
import { PreferencesScreen } from "./PreferencesScreen";

const saved: Prefs = {
  theme: "system",
  syncSources: [
    { kind: "dir", path: "/home/me/.kube" },
    { kind: "file", path: "/etc/k/one.yaml" },
  ],
};

function show(
  prefs: Prefs = saved,
  over: Record<string, (args: never) => unknown> = {},
) {
  const ipc = mockBackend({
    prefs_get: () => prefs,
    prefs_set: () => null,
    ...over,
  });
  render(
    <>
      <PreferencesScreen />
      <Toaster />
    </>,
  );
  return ipc;
}

beforeEach(() => {
  resetPrefsForTest();
  delete document.documentElement.dataset.theme;
});

test("lists sources", async () => {
  show();

  const rows = await screen.findAllByTestId("pref-source-row");

  expect(rows.map((r) => r.textContent)).toEqual([
    expect.stringContaining("/home/me/.kube"),
    expect.stringContaining("/etc/k/one.yaml"),
  ]);
});

test("explains an empty source list", async () => {
  show({ theme: "system", syncSources: [] });

  expect(await screen.findByText(/No kubeconfig sources/)).toBeTruthy();
});

test("shows an error with a retry when prefs cannot be read", async () => {
  let fail = true;
  mockBackend({
    prefs_get: () => {
      if (fail)
        throw { code: "Internal", message: "cannot read", details: null };
      return saved;
    },
  });
  render(<PreferencesScreen />);

  expect(await screen.findByText("cannot read")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findAllByTestId("pref-source-row")).toHaveLength(2);
});

test("adding a path calls prefs_set with it as a file", async () => {
  const ipc = show();
  await screen.findAllByTestId("pref-source-row");

  fireEvent.change(screen.getByTestId("pref-source-input"), {
    target: { value: "  /srv/kube/extra.yaml " },
  });
  fireEvent.click(screen.getByTestId("pref-source-add"));

  await waitFor(() =>
    expect(ipc.callsTo("prefs_set")).toEqual([
      {
        prefs: {
          theme: "system",
          syncSources: [
            ...saved.syncSources,
            { kind: "file", path: "/srv/kube/extra.yaml" },
          ],
        },
      },
    ]),
  );
  expect(await screen.findAllByTestId("pref-source-row")).toHaveLength(3);
  expect(
    (screen.getByTestId("pref-source-input") as HTMLInputElement).value,
  ).toBe("");
});

test.each([
  ["/srv/kube/", "/srv/kube/"],
  ["C:\\kube\\", "C:\\kube\\"],
])("a trailing separator makes %s a folder", async (typed, path) => {
  const ipc = show();
  await screen.findAllByTestId("pref-source-row");

  fireEvent.change(screen.getByTestId("pref-source-input"), {
    target: { value: typed },
  });
  fireEvent.click(screen.getByTestId("pref-source-add"));

  await waitFor(() => expect(ipc.callsTo("prefs_set")).toHaveLength(1));
  const sent = ipc.callsTo("prefs_set")[0]?.prefs as Prefs;
  expect(sent.syncSources.at(-1)).toEqual({ kind: "dir", path });
});

test("a blank or listed path is not saved", async () => {
  const ipc = show();
  await screen.findAllByTestId("pref-source-row");
  const add = screen.getByTestId("pref-source-add") as HTMLButtonElement;

  expect(add.disabled).toBe(true);
  fireEvent.change(screen.getByTestId("pref-source-input"), {
    target: { value: "/home/me/.kube" },
  });
  fireEvent.click(add);

  expect(await screen.findByText(/already listed/)).toBeTruthy();
  expect(ipc.callsTo("prefs_set")).toEqual([]);
});

test("browse file adds the picked path as a file", async () => {
  const ipc = show(saved, { "plugin:dialog|open": () => "/picked/config" });
  await screen.findAllByTestId("pref-source-row");

  fireEvent.click(screen.getByRole("button", { name: "Browse file" }));

  await waitFor(() => expect(ipc.callsTo("prefs_set")).toHaveLength(1));
  const dialog = ipc.callsTo("plugin:dialog|open")[0]?.options as {
    directory: boolean;
  };
  expect(dialog.directory).toBe(false);
  const sent = ipc.callsTo("prefs_set")[0]?.prefs as Prefs;
  expect(sent.syncSources.at(-1)).toEqual({
    kind: "file",
    path: "/picked/config",
  });
});

test("browse folder adds the picked path as a folder", async () => {
  const ipc = show(saved, { "plugin:dialog|open": () => "/picked" });
  await screen.findAllByTestId("pref-source-row");

  fireEvent.click(screen.getByRole("button", { name: "Browse folder" }));

  await waitFor(() => expect(ipc.callsTo("prefs_set")).toHaveLength(1));
  const sent = ipc.callsTo("prefs_set")[0]?.prefs as Prefs;
  expect(sent.syncSources.at(-1)).toEqual({ kind: "dir", path: "/picked" });
});

test("cancelling a browse adds nothing", async () => {
  const ipc = show(saved, { "plugin:dialog|open": () => null });
  await screen.findAllByTestId("pref-source-row");

  fireEvent.click(screen.getByRole("button", { name: "Browse file" }));

  await waitFor(() =>
    expect(ipc.callsTo("plugin:dialog|open")).toHaveLength(1),
  );
  expect(ipc.callsTo("prefs_set")).toEqual([]);
});

test("removing calls prefs_set without it", async () => {
  const ipc = show();
  const [first] = await screen.findAllByTestId("pref-source-row");

  fireEvent.click(
    within(first as HTMLElement).getByRole("button", {
      name: "Remove /home/me/.kube",
    }),
  );

  await waitFor(() =>
    expect(ipc.callsTo("prefs_set")).toEqual([
      {
        prefs: {
          theme: "system",
          syncSources: [{ kind: "file", path: "/etc/k/one.yaml" }],
        },
      },
    ]),
  );
  await waitFor(() =>
    expect(screen.getAllByTestId("pref-source-row")).toHaveLength(1),
  );
});

test("a failed save restores the list and shows the backend's message", async () => {
  show(saved, {
    prefs_set: () => {
      throw { code: "Internal", message: "disk full", details: null };
    },
  });
  const [first] = await screen.findAllByTestId("pref-source-row");

  fireEvent.click(
    within(first as HTMLElement).getByRole("button", {
      name: "Remove /home/me/.kube",
    }),
  );

  expect(await screen.findByText(/disk full/)).toBeTruthy();
  expect(screen.getAllByTestId("pref-source-row")).toHaveLength(2);
});

test("a theme change calls applyTheme and prefs_set", async () => {
  const ipc = show();
  await screen.findAllByTestId("pref-source-row");

  fireEvent.keyDown(screen.getByRole("combobox", { name: "Theme" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: "Dark" }));

  expect(document.documentElement.dataset.theme).toBe("dark");
  await waitFor(() =>
    expect(ipc.callsTo("prefs_set")).toEqual([
      { prefs: { ...saved, theme: "dark" } },
    ]),
  );
  expect(usePrefs.getState().prefs?.theme).toBe("dark");
});
