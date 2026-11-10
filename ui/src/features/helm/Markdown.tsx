import { createElement, type ReactNode, useMemo } from "react";
import styles from "./Markdown.module.css";
import { type Block, type Inline, parseMarkdown } from "./markdown";

// Children are spread into `createElement`, so the lists of a tree need no keys.

function inlineNode(node: Inline): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return createElement("code", { className: styles.code }, node.text);
    case "strong":
      return createElement("strong", null, ...inline(node.children));
    case "em":
      return createElement("em", null, ...inline(node.children));
    case "link":
      // Not an anchor: the text, then where it points, which nothing opens.
      return createElement(
        "span",
        null,
        ...inline(node.children),
        createElement("span", { className: styles.url }, ` (${node.url})`),
      );
    case "break":
      return createElement("br");
  }
}

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map(inlineNode);
}

function listItem(blocks: Block[]): ReactNode {
  const only = blocks[0];
  if (blocks.length === 1 && only?.type === "paragraph") {
    return createElement("li", null, ...inline(only.children));
  }
  return createElement("li", null, ...blocks.map(block));
}

function block(node: Block): ReactNode {
  switch (node.type) {
    case "heading":
      // Two levels down, so a README's headings nest under the drawer's own.
      return createElement(
        `h${Math.min(6, node.level + 2)}`,
        { className: styles.heading },
        ...inline(node.children),
      );
    case "paragraph":
      return createElement("p", null, ...inline(node.children));
    case "rule":
      return createElement("hr");
    case "code":
      return createElement(
        "pre",
        { className: styles.pre },
        createElement(
          "code",
          { "data-lang": node.lang === "" ? undefined : node.lang },
          node.text,
        ),
      );
    case "quote":
      return createElement("blockquote", null, ...node.children.map(block));
    case "list":
      return createElement(
        node.ordered ? "ol" : "ul",
        node.ordered && node.start !== 1 ? { start: node.start } : null,
        ...node.items.map(listItem),
      );
    case "table":
      return createElement(
        "div",
        { className: styles.tableWrap },
        createElement(
          "table",
          null,
          createElement(
            "thead",
            null,
            createElement(
              "tr",
              null,
              ...node.head.map((cell) =>
                createElement("th", null, ...inline(cell)),
              ),
            ),
          ),
          createElement(
            "tbody",
            null,
            ...node.rows.map((row) =>
              createElement(
                "tr",
                null,
                ...row.map((cell) =>
                  createElement("td", null, ...inline(cell)),
                ),
              ),
            ),
          ),
        ),
      );
  }
}

/**
 * A chart README as React elements (spec D1 §13). Raw HTML and entities show as the
 * text they are; links and images load and open nothing.
 */
export function Markdown(props: { text: string; testId?: string }) {
  const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
  return createElement(
    "div",
    { className: styles.markdown, "data-testid": props.testId },
    ...blocks.map(block),
  );
}
