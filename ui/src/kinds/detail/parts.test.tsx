import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HardDrive } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { flush, mockBackend } from "../../test/ipc";
import {
  DrawerKindContext,
  ExpandRow,
  FactList,
  FactRow,
  Item,
  ItemList,
  Part,
  StatGrid,
  SubRow,
  sectionSlug,
  titleKey,
} from "./parts";

afterEach(() => vi.useRealTimers());

test("slugs and title keys", () => {
  expect(sectionSlug("Access Control")).toBe("access-control");
  expect(sectionSlug("Sources (2)")).toBe("sources-2-");
  expect(titleKey("Sources (2)")).toBe("Sources");
  expect(titleKey("Sources")).toBe("Sources");
});

test("a Part is a card that starts open, collapses with its body mounted, and shows its count", () => {
  render(
    <Part title="Volumes" testId="detail-volumes" icon={HardDrive} count={3}>
      <textarea aria-label="draft" defaultValue="kept" />
    </Part>,
  );
  const section = screen.getByTestId("detail-volumes");
  const toggle = screen.getByTestId("detail-section-toggle-volumes");
  expect(section.tagName).toBe("SECTION");
  expect(section.getAttribute("aria-labelledby")).toBe(toggle.id);
  expect(toggle.closest("h4")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toBe("Volumes3");
  const body = document.getElementById(
    toggle.getAttribute("aria-controls") ?? "",
  );
  expect(body?.hidden).toBe(false);
  fireEvent.change(screen.getByLabelText("draft"), {
    target: { value: "edited" },
  });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(body?.hidden).toBe(true);
  fireEvent.click(toggle);
  expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe(
    "edited",
  );
});

test("outside a drawer a Part saves nothing", () => {
  const backend = mockBackend({});
  render(<Part title="Rules">x</Part>);
  fireEvent.click(screen.getByTestId("detail-section-toggle-rules"));
  expect(backend.calls.filter((c) => c.cmd.startsWith("ui_state"))).toEqual([]);
});

test("inside a drawer the collapsed state is saved per kind and title, without the count", async () => {
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) =>
      a.key === "drawer.section.argoproj.io/applications.Sources" ? true : null,
    ui_state_set: () => null,
  });
  render(
    <DrawerKindContext.Provider
      value={{ group: "argoproj.io", plural: "applications" }}
    >
      <Part title="Sources (2)">a</Part>
      <Part title="Health">b</Part>
    </DrawerKindContext.Provider>,
  );
  await act(flush);
  expect(
    screen
      .getByTestId("detail-section-toggle-sources-2-")
      .getAttribute("aria-expanded"),
  ).toBe("false");
  vi.useFakeTimers();
  fireEvent.click(screen.getByTestId("detail-section-toggle-health"));
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(backend.callsTo("ui_state_set")).toContainEqual({
    key: "drawer.section.argoproj.io/applications.Health",
    value: true,
  });
});

test("a Part inside a Part is a sub-heading that keeps its test id", () => {
  render(
    <Part title="Spec">
      <Part title="Rules" testId="rules">
        r
      </Part>
    </Part>,
  );
  const inner = screen.getByTestId("rules");
  expect(within(inner).getByText("Rules").tagName).toBe("H5");
  expect(screen.queryByTestId("detail-section-toggle-rules")).toBeNull();
});

test("an ExpandRow starts closed and opens to its body", () => {
  render(
    <ExpandRow
      label="Labels"
      count={2}
      summary="app=web, tier=front"
      testId="detail-labels"
    >
      <p>body</p>
    </ExpandRow>,
  );
  const toggle = screen.getByTestId("detail-expand-labels");
  expect(screen.getByTestId("detail-labels").contains(toggle)).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toBe("Labels2app=web, tier=front");
  expect(screen.getByText("body").closest("[hidden]")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("body").closest("[hidden]")).toBeNull();
});

test("fact rows, stats, items and sub-rows", () => {
  render(
    <>
      <FactList>
        <FactRow label="Node" testId="fact-node">
          n1
        </FactRow>
      </FactList>
      <StatGrid
        stats={[
          {
            id: "ready",
            label: "Ready",
            value: "1/1",
            title: "Containers ready",
          },
        ]}
      />
      <ItemList>
        <Item testId="item-a" head={<span>a</span>}>
          <SubRow label="Image">nginx</SubRow>
        </Item>
      </ItemList>
    </>,
  );
  expect(screen.getByTestId("fact-node").textContent).toBe("Noden1");
  const stat = screen.getByTestId("detail-stat-ready");
  expect(stat.textContent).toBe("Ready1/1");
  expect(stat.getAttribute("title")).toBe("Containers ready");
  expect(screen.getByTestId("item-a").textContent).toBe("aImagenginx");
});
