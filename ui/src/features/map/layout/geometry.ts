import { type MapModel, nodeOf, statusLine } from "../model";
import { FOCUS_SIZE, NODE_SIZE } from "./constants";

/** Half the width a node's name takes under its icon, from 36 to 110. */
export function labelHalf(name: string): number {
  return Math.max(36, Math.min(200, name.length * 6.6) / 2 + 10);
}

/** The icon size of a node. */
export function leafSize(focus: boolean): number {
  return focus ? FOCUS_SIZE : NODE_SIZE;
}

/** The width of a node's cell: its icon with room around it, or its name. */
export function cellW(name: string, focus: boolean): number {
  return Math.max(leafSize(focus) + 16, 2 * labelHalf(name));
}

/** What a Grouped box shows in its head. */
export interface BoxText {
  title: string;
  sub: string;
}

/** A box of the Grouped layout, as `boxText` reads it. */
export interface BoxRef {
  kind: string;
  /** The owner's node id; empty for namespace and external boxes. */
  id: string;
  name: string;
}

export function boxText(model: MapModel, box: BoxRef): BoxText {
  if (box.kind === "Namespace") return { title: box.name, sub: "Namespace" };
  if (box.kind === "External") {
    return { title: "Outside the cluster", sub: "Load balancers" };
  }
  const node = nodeOf(model, box.id);
  return { title: node.name, sub: `${node.kind} · ${statusLine(node)}` };
}

/** The width a box's head needs for its icon, title and subtitle. */
export function headW(text: BoxText): number {
  return Math.ceil(
    46 + Math.max(text.title.length * 8, text.sub.length * 7.2) + 16,
  );
}
