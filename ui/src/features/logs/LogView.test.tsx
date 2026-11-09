import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mockElementSize } from "../../test/size";
import { LIST_PADDING, type LogJump, LogView, ROW_HEIGHT } from "./LogView";
import { LogBuffer } from "./logBuffer";
import { SearchIndex } from "./logSearch";

const VIEW_HEIGHT = 200;
let buffer = new LogBuffer();
let version = 0;

beforeEach(() => {
  buffer = new LogBuffer();
  version = 0;
  mockElementSize(1000, VIEW_HEIGHT);
  // jsdom has no layout: the list is as tall as its rows and its padding.
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    () => 2 * LIST_PADDING + buffer.size * ROW_HEIGHT,
  );
});

afterEach(() => vi.restoreAllMocks());

function fill(texts: string[]): void {
  for (const text of texts) {
    buffer.push({
      kind: "line",
      pod: "web-1",
      container: "app",
      timestamp: null,
      text,
      truncated: false,
    });
  }
  version += 1;
}

function numbered(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, i) => `line ${from + i}`);
}

function draw(options: { jump?: LogJump; search?: SearchIndex } = {}) {
  return (
    <LogView
      buffer={buffer}
      version={version}
      timestamps={false}
      wrap={false}
      prefix="none"
      empty={null}
      search={options.search ?? new SearchIndex()}
      jump={options.jump ?? null}
    />
  );
}

const view = () => screen.getByTestId("logs-view");
/** jsdom keeps any `scrollTop`, so sticking to the bottom sets the whole height. */
const height = () => 2 * LIST_PADDING + buffer.size * ROW_HEIGHT;

test("new lines keep the list at the bottom", () => {
  fill(numbered(50));
  const { rerender } = render(draw());
  expect(view().scrollTop).toBe(height());

  fill(numbered(10, 50));
  rerender(draw());
  expect(view().scrollTop).toBe(1212);
});

test("scrolling up pauses autoscroll, and scrolling back to the bottom resumes it", () => {
  fill(numbered(50));
  const { rerender } = render(draw());
  view().scrollTop = 300;
  fireEvent.scroll(view());
  fill(numbered(10, 50));
  rerender(draw());
  expect(view().scrollTop).toBe(300);

  view().scrollTop = height() - VIEW_HEIGHT;
  fireEvent.scroll(view());
  fill(numbered(1, 60));
  rerender(draw());
  expect(view().scrollTop).toBe(height());
});

test("End in the list resumes autoscroll", () => {
  fill(numbered(50));
  const { rerender } = render(draw());
  view().scrollTop = 300;
  fireEvent.scroll(view());

  fireEvent.keyDown(view(), { key: "End" });
  expect(view().scrollTop).toBe(height());
  fill(numbered(5, 50));
  rerender(draw());
  expect(view().scrollTop).toBe(height());
});

test("lines dropped off the top keep a paused list on the same lines", () => {
  buffer = new LogBuffer(50);
  fill(numbered(50));
  const { rerender } = render(draw());
  view().scrollTop = 300;
  fireEvent.scroll(view());

  fill(numbered(5, 50));
  rerender(draw());
  expect(buffer.firstSeq).toBe(5);
  expect(view().scrollTop).toBe(200);
});

test("a jump puts its line in the middle and pauses autoscroll; a new nonce jumps again", () => {
  fill(numbered(100));
  const { rerender } = render(draw());
  rerender(draw({ jump: { seq: 40, nonce: 1 } }));
  // 6 px of padding, 40 rows, half a row, less half the view.
  expect(view().scrollTop).toBe(716);

  fill(numbered(5, 100));
  rerender(draw({ jump: { seq: 40, nonce: 1 } }));
  expect(view().scrollTop).toBe(716);

  view().scrollTop = 0;
  fireEvent.scroll(view());
  rerender(draw({ jump: { seq: 40, nonce: 2 } }));
  expect(view().scrollTop).toBe(716);
});

test("a jump near the end stops at the bottom, and its own scroll event keeps autoscroll paused", () => {
  fill(numbered(100));
  const { rerender } = render(draw());
  const end = height() - VIEW_HEIGHT;
  rerender(draw({ jump: { seq: 99, nonce: 1 } }));
  expect(view().scrollTop).toBe(end);

  fireEvent.scroll(view());
  fill(numbered(5, 100));
  rerender(draw({ jump: { seq: 99, nonce: 1 } }));
  expect(view().scrollTop).toBe(end);
});

test("search marks draw the matches, the current one apart, over any ANSI background", () => {
  fill(["alpha", "beta", "ALPHA beta \u001b[41malpha\u001b[0m"]);
  const search = new SearchIndex();
  search.sync("alpha", buffer);
  render(draw({ search }));

  const marked = [...view().querySelectorAll<HTMLElement>("[data-mark]")];
  expect(
    marked.map((m) => [m.textContent, m.dataset.mark, m.className]),
  ).toEqual([
    ["alpha", "current", "current"],
    ["ALPHA", "match", "match"],
    ["alpha", "match", "match"],
  ]);
  expect(marked[2].style.background).toBe("");
});
