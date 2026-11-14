import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../../kinds/objects";
import { resetResourcesForTest } from "../../stores/resources";
import { mockBackend } from "../../test/ipc";
import { DrawerObjectActions } from "./DrawerObjectActions";

const CONFIGMAPS: ApiResourceInfo = {
  resource: {
    group: "",
    version: "v1",
    plural: "configmaps",
    kind: "ConfigMap",
    namespaced: true,
  },
  verbs: [],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
};
const CONFIG: KubeObject = {
  metadata: { name: "app-config", namespace: "n", resourceVersion: "1" },
};

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("a linked object gets its own kind's action bar and delete dialog", async () => {
  const backend = mockBackend({ resource_delete: () => null });
  render(
    <MemoryRouter>
      <DrawerObjectActions clusterId="c1" info={CONFIGMAPS} object={CONFIG} />
    </MemoryRouter>,
  );
  expect(screen.getByTestId("detail-actions")).toBeTruthy();
  fireEvent.keyDown(screen.getByTestId("detail-more-actions"), {
    key: "Enter",
  });
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(/Delete ConfigMap n\/app-config/),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(backend.callsTo("resource_delete")).toHaveLength(1);
  expect(backend.callsTo("resource_delete")[0]).toMatchObject({
    clusterId: "c1",
    resource: CONFIGMAPS.resource,
    namespace: "n",
    name: "app-config",
  });
});
