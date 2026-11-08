import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Menu } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { registerKind } from "../../kinds/registry";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { DetailDrawer } from "./DetailDrawer";

const POD: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
const RS: ApiResourceInfo = {
  resource: {
    group: "apps",
    version: "v1",
    plural: "replicasets",
    kind: "ReplicaSet",
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

function pod(over: Partial<KubeObject> = {}): KubeObject {
  return {
    metadata: {
      name: "web",
      namespace: "team-a",
      uid: "u1",
      resourceVersion: "1",
      creationTimestamp: "2026-01-01T00:00:00Z",
      labels: { app: "web" },
      annotations: { note: "short" },
    },
    spec: { nodeName: "n1" },
    ...over,
  };
}

type Get = (a: {
  clusterId: string;
  resource: ResourceRef;
  namespace: string | null;
  name: string;
}) => unknown;

/**
 * A backend whose watch sends the rows given to `snapshot` and `batch`. By default
 * `resource_get` answers with the row as it is now, or NotFound once it is deleted.
 */
function fake(events: () => unknown = () => [], get?: Get) {
  let send: (e: WatchEvent) => void = () => {};
  const rows = new Map<string, KubeObject>();
  const keep = (o: KubeObject) =>
    rows.set(`${o.metadata.namespace}/${o.metadata.name}`, o);
  const backend = mockBackend({
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub";
    },
    resources_unsubscribe: () => null,
    resource_events: () => events(),
    resource_get:
      get ??
      ((a) => {
        const found = rows.get(`${a.namespace}/${a.name}`);
        if (!found) throw { code: "NotFound", message: `${a.name} not found` };
        return found;
      }),
  });
  return {
    backend,
    // The second act lets the drawer's fetch come back.
    snapshot: async (items: KubeObject[]) => {
      await act(async () => {
        rows.clear();
        items.forEach(keep);
        send({ type: "snapshot", items } as WatchEvent);
        await flush();
      });
      await act(flush);
    },
    batch: async (
      upserts: KubeObject[],
      deletes: { namespace: string; name: string }[] = [],
    ) => {
      await act(async () => {
        upserts.forEach(keep);
        for (const d of deletes) rows.delete(`${d.namespace}/${d.name}`);
        send({ type: "batch", upserts, deletes } as WatchEvent);
        await flush();
      });
      await act(flush);
    },
  };
}

function drawer(onClose = () => {}, key: string | null = "team-a/web") {
  return (
    <MemoryRouter>
      <DetailDrawer
        clusterId="c1"
        resource={POD}
        objectKey={key}
        onClose={onClose}
        resources={[RS]}
      />
    </MemoryRouter>
  );
}

beforeEach(() => resetResourcesForTest());
afterEach(() => {
  resetResourcesForTest();
  vi.restoreAllMocks();
});

test("opens from the URL param and shows metadata, labels, annotations", async () => {
  const f = fake();
  render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  expect(screen.getByTestId("detail-title").textContent).toBe("web");
  expect(
    within(screen.getByTestId("detail-labels")).getByText("app=web"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("detail-annotations")).getByText("short"),
  ).toBeTruthy();
  expect(screen.getByText("team-a")).toBeTruthy();
});

test("renders nothing without an object", async () => {
  fake();
  render(drawer(() => {}, null));
  await act(flush);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
});

test("updates live when the object changes", async () => {
  const f = fake();
  render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  expect(screen.queryByText("app=api")).toBeNull();
  await f.batch([
    pod({
      metadata: {
        ...pod().metadata,
        resourceVersion: "2",
        labels: { app: "api" },
      },
    }),
  ]);
  expect(screen.getByText("app=api")).toBeTruthy();
});

test("shows a removed notice when the object is deleted while open and does not crash", async () => {
  const f = fake();
  render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  await f.batch([], [{ namespace: "team-a", name: "web" }]);
  expect(screen.getByTestId("detail-removed").textContent).toMatch(/deleted/);
  expect(screen.getByTestId("detail-title").textContent).toBe("web");
});

test("an object that is not in the list says so", async () => {
  const f = fake();
  render(drawer(() => {}, "team-a/ghost"));
  await act(flush);
  await f.snapshot([pod()]);
  expect(screen.getByText("Pod not found")).toBeTruthy();
});

test("conditions render type, status, reason and message when present", async () => {
  const f = fake();
  render(drawer());
  await act(flush);
  await f.snapshot([
    pod({
      status: {
        conditions: [
          {
            type: "Ready",
            status: "False",
            reason: "NotReady",
            message: "containers are starting",
          },
          { type: "Initialized", status: "True" },
        ],
      },
    }),
  ]);
  const section = screen.getByTestId("detail-conditions");
  expect(within(section).getByText("Ready")).toBeTruthy();
  expect(within(section).getByText("False")).toBeTruthy();
  expect(within(section).getByText("NotReady")).toBeTruthy();
  expect(within(section).getByText("containers are starting")).toBeTruthy();
  expect(within(section).getByText("Initialized")).toBeTruthy();
});

test("a object without conditions shows no conditions section", async () => {
  const f = fake();
  render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  expect(screen.queryByTestId("detail-conditions")).toBeNull();
});

test("owner references link to the owner's list when the kind is known", async () => {
  const f = fake();
  render(drawer());
  await act(flush);
  await f.snapshot([
    pod({
      metadata: {
        ...pod().metadata,
        ownerReferences: [
          {
            apiVersion: "apps/v1",
            kind: "ReplicaSet",
            name: "web-1",
            uid: "o1",
          },
          { apiVersion: "x.io/v1", kind: "Widget", name: "w", uid: "o2" },
        ],
      },
    }),
  ]);
  const links = screen.getAllByTestId("detail-owner-link");
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("href")).toBe(
    "/cluster/c1/r/apps/replicasets?object=team-a%2Fweb-1",
  );
  expect(screen.getByText("Widget w")).toBeTruthy();
});

test("events section loads for this object and shows an empty state", async () => {
  const f = fake();
  render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Events" }), {
    button: 0,
  });
  await waitFor(() =>
    expect(
      within(screen.getByTestId("detail-events")).getByText(
        "No events for this object.",
      ),
    ).toBeTruthy(),
  );
  expect(f.backend.callsTo("resource_events")[0]).toEqual({
    clusterId: "c1",
    involved: { kind: "Pod", namespace: "team-a", name: "web", uid: "u1" },
  });
});

test("events are listed with type, reason and message", async () => {
  const f = fake(() => [
    {
      type: "Warning",
      reason: "BackOff",
      message: "restarting",
      count: 3,
      lastTimestamp: "2026-01-01T00:00:00Z",
    },
  ]);
  render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Events" }), {
    button: 0,
  });
  const section = await screen.findByTestId("detail-events");
  await waitFor(() =>
    expect(within(section).getByText("BackOff")).toBeTruthy(),
  );
  expect(within(section).getByText("Warning")).toBeTruthy();
  expect(within(section).getByText("restarting")).toBeTruthy();
  expect(within(section).getByText("x3")).toBeTruthy();
});

test("events failure shows the error only in that section", async () => {
  const f = fake(() => {
    throw { code: "Forbidden", message: "events are forbidden" };
  });
  render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Events" }), {
    button: 0,
  });
  const section = await screen.findByTestId("detail-events");
  await waitFor(() => expect(within(section).getByRole("alert")).toBeTruthy());
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByTestId("detail-title").textContent).toBe("web");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Overview" }), {
    button: 0,
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("detail-labels")).toBeTruthy();
});

test("uses the kind's registered detail when there is one, otherwise the field tree", async () => {
  const f = fake();
  const { unmount } = render(drawer());
  await act(flush);
  await f.snapshot([pod()]);
  expect(screen.getByTestId("detail-fields")).toBeTruthy();
  expect(screen.getByText("nodeName")).toBeTruthy();
  unmount();
  resetResourcesForTest();

  registerKind("", "pods", {
    detail: (p) => (
      <div data-testid="pod-detail">node {p.object.spec.nodeName}</div>
    ),
  });
  try {
    const g = fake();
    render(drawer());
    await act(flush);
    await g.snapshot([pod()]);
    expect(screen.getByTestId("pod-detail").textContent).toBe("node n1");
    expect(screen.queryByTestId("detail-fields")).toBeNull();
  } finally {
    registerKind("", "pods", {});
  }
});

function Host(props: { open: boolean; onClose(): void }) {
  return (
    <MemoryRouter>
      <button type="button" data-testid="row">
        row
      </button>
      <DetailDrawer
        clusterId="c1"
        resource={POD}
        objectKey={props.open ? "team-a/web" : null}
        onClose={props.onClose}
      />
    </MemoryRouter>
  );
}
test("Escape closes and focus returns to the row", async () => {
  const f = fake();
  const onClose = vi.fn();
  const { rerender } = render(<Host open={false} onClose={onClose} />);
  await act(flush);
  await f.snapshot([pod()]);
  screen.getByTestId("row").focus();
  rerender(<Host open onClose={onClose} />);
  await act(flush);
  expect(document.activeElement).toBe(screen.getByTestId("detail-drawer"));
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  rerender(<Host open={false} onClose={onClose} />);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  expect(document.activeElement).toBe(screen.getByTestId("row"));
});

test("the close button closes", async () => {
  const f = fake();
  const onClose = vi.fn();
  render(drawer(onClose));
  await act(flush);
  await f.snapshot([pod()]);
  fireEvent.click(screen.getByTestId("detail-close"));
  expect(onClose).toHaveBeenCalled();
});

test("long annotation values stay collapsed with an expand control", async () => {
  const f = fake();
  const long = "x".repeat(300);
  render(drawer());
  await act(flush);
  await f.snapshot([
    pod({
      metadata: { ...pod().metadata, annotations: { big: long, small: "ok" } },
    }),
  ]);
  const section = screen.getByTestId("detail-annotations");
  const expand = within(section).getByRole("button", {
    name: "Expand annotation big",
  });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  // Only the long one has a control.
  expect(within(section).getAllByRole("button")).toHaveLength(1);
  fireEvent.click(expand);
  const collapse = within(section).getByRole("button", {
    name: "Collapse annotation big",
  });
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
});

test("moving to another object goes back to the overview without fetching events", async () => {
  const f = fake();
  const view = render(drawer(() => {}, "team-a/web"));
  await act(flush);
  await f.snapshot([
    pod(),
    pod({ metadata: { name: "other", namespace: "team-a" } }),
  ]);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Events" }), {
    button: 0,
  });
  await act(flush);
  const before = f.backend.callsTo("resource_events").length;
  view.rerender(drawer(() => {}, "team-a/other"));
  await act(flush);
  expect(f.backend.callsTo("resource_events")).toHaveLength(before);
  expect(
    screen.getByRole("tab", { name: "Overview" }).getAttribute("data-state"),
  ).toBe("active");
});

test("Escape inside a textarea does not close the drawer", async () => {
  const f = fake();
  const onClose = vi.fn();
  render(drawer(onClose));
  await act(flush);
  await f.snapshot([pod()]);
  const area = document.createElement("textarea");
  screen.getByTestId("detail-drawer").appendChild(area);
  fireEvent.keyDown(area, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});

test("the overview stays mounted while the Events tab is open", async () => {
  const f = fake();
  render(drawer(() => {}));
  await act(flush);
  await f.snapshot([pod()]);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Events" }), {
    button: 0,
  });
  await act(flush);
  const hidden = screen
    .getByTestId("detail-drawer")
    .querySelector<HTMLElement>("[hidden]");
  expect(hidden).not.toBeNull();
  expect(hidden?.textContent).toContain("Labels");
});

// A Pod row keeps only some fields (see "Watched Pod rows" in the IPC contract), so the
// drawer shows the object from resource_get.
function trimmedRow(rv = "1"): KubeObject {
  return {
    metadata: {
      name: "web",
      namespace: "team-a",
      uid: "u1",
      resourceVersion: rv,
    },
    spec: { containers: [{ name: "main" }] },
    status: { conditions: [{ type: "Ready", status: "False" }] },
  };
}
function wholePod(rv = "1", note = "whole"): KubeObject {
  return {
    ...trimmedRow(rv),
    metadata: { ...trimmedRow(rv).metadata, annotations: { note } },
    status: {
      conditions: [{ type: "Ready", status: "False", message: "probe failed" }],
    },
  };
}

test("a pod is fetched whole when the drawer opens", async () => {
  const f = fake(undefined, () => wholePod());
  render(drawer());
  await act(flush);
  await f.snapshot([trimmedRow()]);
  expect(f.backend.callsTo("resource_get")).toEqual([
    { clusterId: "c1", resource: POD, namespace: "team-a", name: "web" },
  ]);
  expect(
    within(screen.getByTestId("detail-annotations")).getByText("whole"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("detail-conditions")).getByText("probe failed"),
  ).toBeTruthy();
});

test("the drawer waits for the fetch rather than showing the trimmed row", async () => {
  let answer: (o: KubeObject) => void = () => {};
  const f = fake(
    undefined,
    () => new Promise<KubeObject>((resolve) => (answer = resolve)),
  );
  render(drawer());
  await act(flush);
  await f.snapshot([trimmedRow()]);
  expect(screen.getByLabelText("Loading details")).toBeTruthy();
  expect(screen.queryByTestId("detail-annotations")).toBeNull();
  await act(async () => {
    answer(wholePod());
    await flush();
  });
  expect(screen.getByText("whole")).toBeTruthy();
});

test("a pod is fetched again only when the row's resourceVersion changes", async () => {
  let version = "1";
  const f = fake(undefined, () => wholePod(version, `v${version}`));
  render(drawer());
  await act(flush);
  await f.snapshot([trimmedRow("1")]);
  expect(screen.getByText("v1")).toBeTruthy();
  // The same version again, as a resync sends it, fetches nothing.
  await f.batch([trimmedRow("1")]);
  expect(f.backend.callsTo("resource_get")).toHaveLength(1);
  version = "2";
  await f.batch([trimmedRow("2")]);
  expect(f.backend.callsTo("resource_get")).toHaveLength(2);
  expect(screen.getByText("v2")).toBeTruthy();
});

test("an answer for an older version never replaces a newer one", async () => {
  const answers: ((o: KubeObject) => void)[] = [];
  const f = fake(
    undefined,
    () => new Promise<KubeObject>((resolve) => answers.push(resolve)),
  );
  render(drawer());
  await act(flush);
  await f.snapshot([trimmedRow("1")]);
  await f.batch([trimmedRow("2")]);
  expect(answers).toHaveLength(2);
  await act(async () => {
    answers[1](wholePod("2", "new"));
    await flush();
  });
  await act(async () => {
    answers[0](wholePod("1", "old"));
    await flush();
  });
  expect(screen.getByText("new")).toBeTruthy();
  expect(screen.queryByText("old")).toBeNull();
});

test("a deleted pod keeps the last fetched object with the deleted notice", async () => {
  const f = fake(undefined, () => wholePod());
  render(drawer());
  await act(flush);
  await f.snapshot([trimmedRow()]);
  await f.batch([], [{ namespace: "team-a", name: "web" }]);
  expect(screen.getByTestId("detail-removed").textContent).toMatch(/deleted/);
  expect(screen.getByText("whole")).toBeTruthy();
  expect(screen.getByText("probe failed")).toBeTruthy();
  expect(f.backend.callsTo("resource_get")).toHaveLength(1);
});

test("opening the pod again fetches it again", async () => {
  const f = fake(undefined, () => wholePod());
  const view = render(drawer());
  await act(flush);
  await f.snapshot([trimmedRow()]);
  view.rerender(drawer(() => {}, null));
  await act(flush);
  view.rerender(drawer());
  await act(flush);
  expect(f.backend.callsTo("resource_get")).toHaveLength(2);
  expect(screen.getByText("whole")).toBeTruthy();
});

test("a failed fetch shows the error and Retry fetches again", async () => {
  let fail = true;
  const f = fake(undefined, () => {
    if (fail) throw { code: "Forbidden", message: "pods is forbidden" };
    return wholePod();
  });
  render(drawer());
  await act(flush);
  await f.snapshot([trimmedRow()]);
  const notice = screen.getByTestId("detail-fetch-error");
  expect(within(notice).getByText("pods is forbidden")).toBeTruthy();
  expect(screen.queryByTestId("detail-annotations")).toBeNull();
  fail = false;
  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(screen.queryByTestId("detail-fetch-error")).toBeNull();
  expect(screen.getByText("whole")).toBeTruthy();
});

test("other kinds show their row and fetch nothing", async () => {
  const CM: ResourceRef = {
    group: "",
    version: "v1",
    plural: "configmaps",
    kind: "ConfigMap",
    namespaced: true,
  };
  const f = fake();
  render(
    <MemoryRouter>
      <DetailDrawer
        clusterId="c1"
        resource={CM}
        objectKey="team-a/web"
        onClose={() => {}}
      />
    </MemoryRouter>,
  );
  await act(flush);
  await f.snapshot([pod()]);
  expect(screen.getByText("app=web")).toBeTruthy();
  expect(f.backend.callsTo("resource_get")).toHaveLength(0);
});

function withActions(
  actions: (o: KubeObject) => React.ReactNode,
  onClose = () => {},
) {
  return (
    <MemoryRouter>
      <DetailDrawer
        clusterId="c1"
        resource={POD}
        objectKey="team-a/web"
        onClose={onClose}
        actions={actions}
      />
    </MemoryRouter>
  );
}

const probe = (o: KubeObject) => (
  <button type="button" data-testid="probe">
    {o.metadata.uid}
  </button>
);

test("the header shows the actions of the object shown, then a divider and Close", async () => {
  const f = fake();
  render(withActions(probe));
  await act(flush);
  await f.snapshot([pod()]);
  const button = screen.getByTestId("probe");
  expect(button.textContent).toBe("u1");
  const divider = button.nextElementSibling as HTMLElement;
  expect(divider.getAttribute("aria-hidden")).toBe("true");
  expect(divider.nextElementSibling).toBe(screen.getByTestId("detail-close"));
});

test("a deleted object keeps how it looked but gets no actions", async () => {
  const f = fake();
  render(withActions(probe));
  await act(flush);
  await f.snapshot([pod()]);
  expect(screen.getByTestId("probe")).toBeTruthy();
  await f.batch([], [{ namespace: "team-a", name: "web" }]);
  expect(screen.getByTestId("detail-removed")).toBeTruthy();
  expect(screen.queryByTestId("probe")).toBeNull();
});

test("Escape in a menu the drawer opened closes the menu, not the drawer", async () => {
  const f = fake();
  const onClose = vi.fn();
  render(
    withActions(
      () => (
        <Menu
          trigger={
            <button type="button" data-testid="probe-menu">
              More
            </button>
          }
          items={[{ id: "x", label: "X", onSelect: () => {} }]}
        />
      ),
      onClose,
    ),
  );
  await act(flush);
  await f.snapshot([pod()]);
  fireEvent.keyDown(screen.getByTestId("probe-menu"), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("detail-drawer"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
