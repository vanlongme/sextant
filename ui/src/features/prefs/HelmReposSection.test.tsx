import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { HelmRepo } from "../../ipc/generated/HelmRepo";
import { resetHelmForTest, useHelm } from "../../stores/helm";
import { chart, HELM_MISSING } from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { HelmReposSection } from "./HelmReposSection";
import { checkRepo, placeFailure, RepoRemoveDialog } from "./RepoDialogs";

beforeEach(() => resetHelmForTest());
afterEach(() => vi.restoreAllMocks());

const REPOS: HelmRepo[] = [
  { name: "bitnami", url: "https://charts.example/bitnami" },
  { name: "stable", url: "https://charts.example/stable" },
];
const SEARCH = {
  charts: [chart({ name: "nginx" }), chart({ name: "redis" })],
  repoProblems: [],
};

async function show(
  over: Parameters<typeof mockBackend>[0] = {},
  at = "/preferences",
) {
  const backend = mockBackend({
    helm_repo_list: () => REPOS,
    helm_chart_search: () => SEARCH,
    ...over,
  });
  render(
    <MemoryRouter initialEntries={[at]}>
      <HelmReposSection />
    </MemoryRouter>,
  );
  await act(flush);
  return backend;
}

const dialog = () => screen.getByTestId("helm-repo-add-dialog");
const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const addButton = () =>
  screen.getByTestId("helm-repo-add-submit") as HTMLButtonElement;
function type(id: string, value: string) {
  fireEvent.change(input(id), { target: { value } });
}

test("lists the repositories with their URL and buttons", async () => {
  await show();
  const row = screen.getByTestId("pref-repo-bitnami");
  expect(row.textContent).toContain("bitnamihttps://charts.example/bitnami");
  expect(
    within(row).getByRole("button", { name: "Update bitnami" }),
  ).toBeTruthy();
  expect(
    within(row).getByRole("button", { name: "Remove repository bitnami" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "helm's own list in repositories.yaml, so it matches your CLI.",
    ),
  ).toBeTruthy();
});

test("an update shows Updating in its row and blocks Update all until it ends", async () => {
  let finish: () => void = () => {};
  const backend = await show({
    helm_repo_update: () =>
      new Promise<null>((resolve) => {
        finish = () => resolve(null);
      }),
  });
  fireEvent.click(screen.getByTestId("pref-repo-update-stable"));
  await act(flush);
  expect(backend.callsTo("helm_repo_update")).toEqual([{ names: ["stable"] }]);
  expect(screen.getByTestId("pref-repo-stable").textContent).toContain(
    "Updating",
  );
  expect(screen.queryByTestId("pref-repo-update-stable")).toBeNull();
  expect(
    (screen.getByTestId("pref-repos-update-all") as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => {
    finish();
    await flush();
  });
  expect(screen.getByTestId("pref-repo-update-stable")).toBeTruthy();
  fireEvent.click(screen.getByTestId("pref-repos-update-all"));
  await act(flush);
  expect(backend.callsTo("helm_repo_update")[1]).toEqual({ names: null });
});

test("no repositories says so and Update all is disabled", async () => {
  await show({ helm_repo_list: () => [] });
  expect(screen.getByTestId("pref-repos-empty").textContent).toBe(
    "No repositories. Add one to browse its charts.",
  );
  expect(
    (screen.getByTestId("pref-repos-update-all") as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("missing helm says to download it and disables the buttons", async () => {
  await show({
    helm_repo_list: () => {
      throw HELM_MISSING;
    },
  });
  expect(
    screen.getByText("helm is missing. Download it under Tools."),
  ).toBeTruthy();
  expect(
    (screen.getByTestId("pref-repos-add") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId("pref-repos-update-all") as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("opening at #helm-repositories scrolls the section into view", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  await show({}, "/preferences#helm-repositories");
  expect(scroll).toHaveBeenCalledWith({ block: "start" });
  expect(scroll.mock.contexts[0]).toBe(screen.getByTestId("pref-repos"));
});

test("Add is disabled until Name and URL are set, and checks the fields after the first press", async () => {
  await show();
  fireEvent.click(screen.getByTestId("pref-repos-add"));
  expect(dialog().textContent).toContain(
    "This runs helm repo add, so the repository is in your CLI too. Credentials go to helm's repositories.yaml, not to SkoposIDE.",
  );
  expect(input("helm-repo-add-name").placeholder).toBe("incubator");
  expect(input("helm-repo-add-url").placeholder).toBe(
    "https://charts.example/stable",
  );
  expect(input("helm-repo-add-password").type).toBe("password");
  expect(within(dialog()).getByText("For basic auth")).toBeTruthy();
  expect(addButton().disabled).toBe(true);

  type("helm-repo-add-name", "my repo");
  type("helm-repo-add-url", "oci://registry.example/charts");
  type("helm-repo-add-password", "secret");
  // Nothing shows before the first Add.
  expect(within(dialog()).queryAllByRole("alert")).toEqual([]);
  fireEvent.click(addButton());
  await act(flush);
  expect(
    within(dialog())
      .getAllByRole("alert")
      .map((a) => a.textContent),
  ).toEqual([
    "Letters, digits, dots, dashes and underscores",
    "OCI registries are not supported here; add an http:// or https:// chart repository",
    "A password needs a username",
  ]);
});

test("the field checks", () => {
  const ok = { name: "a.b_c-1", url: "https://x", username: "", password: "" };
  expect(checkRepo(ok)).toEqual({});
  expect(checkRepo({ ...ok, url: "ftp://x" }).url).toBe(
    "Use an http:// or https:// address",
  );
  expect(checkRepo({ ...ok, username: "me" }).password).toBe(
    "A username needs a password",
  );
});

test.each([
  ["Conflict", "repository bitnami already exists", "name"],
  ["Unreachable", "no such host", "url"],
  ["InvalidInput", "the username holds a control character", "username"],
  ["InvalidInput", "something else", "form"],
  ["Internal", "boom", "form"],
] as const)("a %s refusal shows under %s", (code, message, place) => {
  expect(placeFailure({ code, message } as never)).toEqual({
    [place]: message,
  });
});

test("a refused add shows the error under its field; a good add closes and toasts", async () => {
  const success = vi.spyOn(toast, "success");
  let refuse = true;
  const backend = await show({
    helm_repo_add: () => {
      if (refuse) {
        throw { code: "Unreachable", message: "no such host", details: null };
      }
      return null;
    },
  });
  fireEvent.click(screen.getByTestId("pref-repos-add"));
  type("helm-repo-add-name", "bitnami2");
  type("helm-repo-add-url", "https://charts.example/bitnami");
  type("helm-repo-add-username", "me");
  type("helm-repo-add-password", "secret");
  fireEvent.click(addButton());
  await act(flush);
  expect(within(dialog()).getByRole("alert").textContent).toBe("no such host");

  refuse = false;
  fireEvent.click(addButton());
  await act(flush);
  expect(backend.callsTo("helm_repo_add")[1]).toEqual({
    repo: {
      name: "bitnami2",
      url: "https://charts.example/bitnami",
      username: "me",
      password: "secret",
    },
  });
  expect(screen.queryByTestId("helm-repo-add-dialog")).toBeNull();
  expect(success).toHaveBeenCalledWith(
    '"bitnami2" has been added to your repositories',
    "0 charts in its index",
  );
});

test("Remove asks with the count of charts that leave, then removes", async () => {
  const backend = await show({ helm_repo_remove: () => null });
  fireEvent.click(screen.getByTestId("pref-repo-remove-bitnami"));
  const confirm = await screen.findByTestId("helm-repo-remove-dialog");
  expect(confirm.textContent).toContain("Remove repository bitnami?");
  expect(confirm.textContent).toContain(
    "This runs helm repo remove. Its 2 charts leave the chart list. Releases installed from it keep running and can still be uninstalled.",
  );
  fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
  await act(flush);
  expect(backend.callsTo("helm_repo_remove")).toEqual([{ name: "bitnami" }]);
  expect(screen.queryByTestId("helm-repo-remove-dialog")).toBeNull();
});

test("a failed remove toasts", async () => {
  const error = vi.spyOn(toast, "error");
  await show({
    helm_repo_remove: () => {
      throw { code: "Internal", message: "locked", details: null };
    },
  });
  fireEvent.click(screen.getByTestId("pref-repo-remove-stable"));
  const confirm = await screen.findByTestId("helm-repo-remove-dialog");
  expect(confirm.textContent).toContain("Its 0 charts leave the chart list.");
  fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
  await act(flush);
  expect(error).toHaveBeenCalledWith("Could not remove stable", "locked");
});

test("the remove text reads one chart in the singular, and leaves out an unknown count", () => {
  const { unmount } = render(
    <RepoRemoveDialog name="bitnami" onClose={() => {}} />,
  );
  expect(screen.getByTestId("helm-repo-remove-dialog").textContent).toContain(
    "This runs helm repo remove. Its charts leave the chart list.",
  );
  unmount();
  useHelm.setState({
    charts: {
      search: { charts: [chart({ name: "nginx" })], repoProblems: [] },
      error: null,
      loading: false,
    },
  });
  render(<RepoRemoveDialog name="bitnami" onClose={() => {}} />);
  expect(screen.getByTestId("helm-repo-remove-dialog").textContent).toContain(
    "Its 1 chart leaves the chart list.",
  );
});
