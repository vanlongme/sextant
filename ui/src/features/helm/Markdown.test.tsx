import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown } from "./Markdown";
import { type Block, type Inline, parseMarkdown } from "./markdown";

function show(text: string): HTMLElement {
  const { container } = render(<Markdown text={text} testId="md" />);
  return container.firstElementChild as HTMLElement;
}

/** The tags of the element's children, with their text, for a compact check. */
function shape(root: Element): [string, string][] {
  return Array.from(root.children).map((el) => [
    el.tagName.toLowerCase(),
    el.textContent ?? "",
  ]);
}

test("headings sit two levels down, and the deepest ones stay h6", () => {
  const root = show(
    "# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six ##",
  );
  expect(root.dataset.testid).toBe("md");
  expect(shape(root)).toEqual([
    ["h3", "One"],
    ["h4", "Two"],
    ["h5", "Three"],
    ["h6", "Four"],
    ["h6", "Five"],
    ["h6", "Six"],
  ]);
});

test("#hashtag with no space is text, not a heading", () => {
  expect(shape(show("#hashtag"))).toEqual([["p", "#hashtag"]]);
});

test("paragraphs split on blank lines; two spaces or a backslash break a line", () => {
  const root = show("first line\nsame paragraph\n\nhard  \nbreak\\\nagain");
  expect(shape(root)).toEqual([
    ["p", "first line\nsame paragraph"],
    ["p", "hardbreakagain"],
  ]);
  expect(root.children[1]?.querySelectorAll("br")).toHaveLength(2);
});

test("---, *** and ___ are horizontal rules", () => {
  expect(shape(show("a\n\n---\n\n* * *\n\n___"))).toEqual([
    ["p", "a"],
    ["hr", ""],
    ["hr", ""],
    ["hr", ""],
  ]);
});

test("unordered lists with -, * and +, nested by indentation", () => {
  const root = show(
    "- one\n- two\n  - two.a\n    - two.a.i\n  - two.b\n* star\n+ plus",
  );
  const list = root.firstElementChild as HTMLElement;
  expect(list.tagName).toBe("UL");
  const items = Array.from(list.children).map((li) =>
    li.firstChild?.textContent?.trim(),
  );
  expect(items).toEqual(["one", "two", "star", "plus"]);
  const nested = list.children[1]?.querySelector("ul") as HTMLElement;
  expect(
    Array.from(nested.children).map((li) => li.firstChild?.textContent),
  ).toEqual(["two.a", "two.b"]);
  expect(nested.querySelector("ul")?.textContent).toBe("two.a.i");
});

test("ordered lists keep their first number", () => {
  const root = show("3. three\n4. four\n   1. inner\n\n1. again");
  const list = root.firstElementChild as HTMLOListElement;
  expect(list.tagName).toBe("OL");
  expect(list.getAttribute("start")).toBe("3");
  expect(list.children).toHaveLength(3);
  expect(list.children[1]?.querySelector("ol")?.textContent).toBe("inner");
  expect(list.children[2]?.textContent).toBe("again");
});

test("a lazy line carries an item's paragraph on", () => {
  const root = show("- an item that\nwraps\n\nafter");
  expect(shape(root)).toEqual([
    ["ul", "an item that\nwraps"],
    ["p", "after"],
  ]);
});

test("block quotes hold blocks of their own", () => {
  const root = show("> quoted\n> - item\n\nplain");
  expect(shape(root)).toEqual([
    ["blockquote", "quoteditem"],
    ["p", "plain"],
  ]);
  expect(root.querySelector("blockquote ul")?.textContent).toBe("item");
});

test("fenced code with ``` or ~~~, with or without a language, keeps its text", () => {
  const root = show(
    "```yaml\nreplicaCount: 2\n  # **not bold**\n```\n\n~~~\n<b>raw</b>\n~~~\n\n```\nunclosed",
  );
  const blocks = Array.from(root.querySelectorAll("pre > code"));
  expect(
    blocks.map((c) => [c.getAttribute("data-lang"), c.textContent]),
  ).toEqual([
    ["yaml", "replicaCount: 2\n  # **not bold**"],
    [null, "<b>raw</b>"],
    [null, "unclosed"],
  ]);
  expect(root.querySelector("strong, b")).toBeNull();
});

test("GitHub pipe tables, with escaped pipes and short rows", () => {
  const root = show(
    "| Name | Default |\n|:---|---:|\n| `image.tag` | `1.2` |\n| a \\| b |\n\nafter",
  );
  const table = root.querySelector("table") as HTMLTableElement;
  expect(
    Array.from(table.querySelectorAll("th")).map((th) => th.textContent),
  ).toEqual(["Name", "Default"]);
  const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.children).map((td) => td.textContent),
  );
  expect(rows).toEqual([
    ["image.tag", "1.2"],
    ["a | b", ""],
  ]);
  expect(table.querySelectorAll("tbody code")).toHaveLength(2);
  expect(root.lastElementChild?.textContent).toBe("after");
});

test("inline code, bold and italic in both spellings", () => {
  const root = show(
    "`a*b*` **bold** __also__ *it* _too_ snake_case_name 2 * 3",
  );
  const p = root.firstElementChild as HTMLElement;
  expect(p.querySelector("code")?.textContent).toBe("a*b*");
  expect(
    Array.from(p.querySelectorAll("strong")).map((s) => s.textContent),
  ).toEqual(["bold", "also"]);
  expect(
    Array.from(p.querySelectorAll("em")).map((s) => s.textContent),
  ).toEqual(["it", "too"]);
  expect(p.textContent).toBe("a*b* bold also it too snake_case_name 2 * 3");
});

test("bold inside italic, and a backslash escape", () => {
  const p = show("*a **b** c* \\*not italic\\*")
    .firstElementChild as HTMLElement;
  expect(p.querySelector("em")?.textContent).toBe("a b c");
  expect(p.querySelector("em strong")?.textContent).toBe("b");
  expect(p.textContent).toBe("a b c *not italic*");
});

test("a link shows its text and its URL, and is not an anchor", () => {
  const root = show(
    'See [the **docs**](https://charts.example/docs "Docs") and <https://charts.example>.',
  );
  expect(root.querySelector("a")).toBeNull();
  expect(root.textContent).toBe(
    "See the docs (https://charts.example/docs) and https://charts.example.",
  );
  const url = Array.from(root.querySelectorAll("span")).find(
    (s) => s.textContent === " (https://charts.example/docs)",
  );
  expect(url?.classList.contains("url")).toBe(true);
  expect(root.querySelector("strong")?.textContent).toBe("docs");
});

test("an image shows its alt text and loads nothing", () => {
  const root = show("![The logo](https://tracker.example/pixel.png) after");
  expect(root.querySelector("img")).toBeNull();
  expect(root.textContent).toBe("The logo after");
});

test("raw HTML and entities show as literal text", () => {
  const html =
    '<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n<a href="https://x.example">x</a> &amp; &lt;b&gt;';
  const root = show(html);
  expect(root.querySelector("script, img, a, iframe")).toBeNull();
  expect(shape(root)).toEqual([
    ["p", "<script>alert(1)</script>"],
    ["p", '<img src="x" onerror="alert(2)">'],
    ["p", '<a href="https://x.example">x</a> &amp; &lt;b&gt;'],
  ]);
});

test("a javascript: link is text like any other", () => {
  const root = show("[click](javascript:alert(1))");
  expect(root.querySelector("a")).toBeNull();
  expect(root.textContent).toBe("click (javascript:alert(1))");
});

test("anything else is a paragraph", () => {
  expect(shape(show("Title\n=====\n\n    indented"))).toEqual([
    ["p", "Title\n====="],
    ["p", "indented"],
  ]);
});

test("deeply nested quotes and lists do not throw", () => {
  expect(() => parseMarkdown(">".repeat(10000))).not.toThrow();
  const nested = Array.from(
    { length: 5000 },
    (_, i) => `${" ".repeat(i * 2)}- x`,
  ).join("\n");
  expect(() => parseMarkdown(nested)).not.toThrow();
  const root = show(">".repeat(10000));
  expect(root.textContent).toContain(">");
});

test("links nest at most 16 deep; deeper brackets stay as text", () => {
  const blocks = parseMarkdown(`${"[".repeat(40)}x${"](u)".repeat(40)}`);
  const paragraph = blocks[0] as Extract<Block, { type: "paragraph" }>;
  let node: Inline | undefined = paragraph.children[0];
  let depth = 0;
  while (node?.type === "link") {
    depth += 1;
    node = node.children[0];
  }
  expect(depth).toBe(16);
  expect(node).toEqual({ type: "text", text: expect.stringContaining("[x]") });
});

test("a README over 500,000 characters shows as plain text", () => {
  const text = `# Title\n${"x".repeat(500_000)}`;
  expect(parseMarkdown(text)).toEqual([
    { type: "paragraph", children: [{ type: "text", text }] },
  ]);
});

test("a long ordinary README keeps its formatting to the end", () => {
  const paragraph =
    "Set **replicas** with `--set replicaCount=2`, see [the docs](https://charts.example/docs) and *mind* snake_case keys.";
  const blocks = parseMarkdown(Array(3000).fill(paragraph).join("\n\n"));
  expect(blocks).toHaveLength(3000);
  const last = blocks[2999] as Extract<Block, { type: "paragraph" }>;
  expect(last.children.map((node) => node.type)).toEqual([
    "text",
    "strong",
    "text",
    "code",
    "text",
    "link",
    "text",
    "em",
    "text",
  ]);
});

const n = 50_000;
test.each([
  ["spaces inside a heading", `# a${" ".repeat(n)}b`],
  ["spaces after a table delimiter", `a|b\n-${" ".repeat(n)}x`],
  ["spaces before a line break", `a${" ".repeat(n)}b\nc`],
  ["a long code span with a leading space", `\` ${"a".repeat(n)}\``],
  ["brackets that never close", "[".repeat(n)],
  ["emphasis that never closes", "*a ".repeat(n / 3)],
  ["a list of rules", `${"- ".repeat(n / 2)}x`],
])("untrusted input stays fast: %s", (_name, text) => {
  const started = performance.now();
  parseMarkdown(text);
  expect(performance.now() - started).toBeLessThan(1000);
});
