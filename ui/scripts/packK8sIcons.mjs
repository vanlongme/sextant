// Packs the Kubernetes Icons Set files the resource map uses into path data (spec E §14.1).
// Usage, from the repository root: node ui/scripts/packK8sIcons.mjs <icon dir> <out.ts>
// Each icon becomes { vb, paths: [{ d, s, t }] }: `s` is its paint as a style string and `t`
// joins its ancestors' transforms. <use> elements are resolved to their target, and the
// editor metadata is dropped. Shapes and colours are not changed.
import { readFileSync, writeFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const NAMES = [
  "pod",
  "deploy",
  "rs",
  "sts",
  "ds",
  "job",
  "cronjob",
  "svc",
  "ing",
  "cm",
  "secret",
  "sa",
  "pvc",
  "ns",
  "crd",
];
const XLINK = "http://www.w3.org/1999/xlink";
const PAINT = [
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
];
const SKIPPED = new Set(["metadata", "defs", "namedview", "title", "desc"]);

/** Long decimals cut to three places. */
function rnd(text) {
  return text.replace(/-?\d+\.\d{4,}/g, (m) =>
    Number(m)
      .toFixed(3)
      .replace(/\.?0+$/, ""),
  );
}

/** The element's presentation attributes and inline style over the inherited paint. */
function paintOf(el, inherited) {
  const paint = { ...inherited };
  delete paint.opacity;
  for (const key of PAINT) {
    const value = el.getAttribute(key);
    if (value !== null) paint[key] = value;
  }
  for (const item of (el.getAttribute("style") ?? "").split(";")) {
    const at = item.indexOf(":");
    if (at < 0) continue;
    const key = item.slice(0, at).trim();
    if (PAINT.includes(key)) paint[key] = item.slice(at + 1).trim();
  }
  if (inherited.opacity !== undefined && paint.opacity !== undefined) {
    paint.opacity = String(Number(inherited.opacity) * Number(paint.opacity));
  } else if (inherited.opacity !== undefined) {
    paint.opacity = inherited.opacity;
  }
  return paint;
}

function visible(paint) {
  const fills =
    (paint.fill ?? "#000000") !== "none" && paint["fill-opacity"] !== "0";
  const strokes =
    (paint.stroke ?? "none") !== "none" &&
    Number(paint["stroke-width"] ?? "1") > 0;
  return fills || strokes;
}

function styleOf(paint) {
  const out = { fill: paint.fill ?? "#000000" };
  for (const key of PAINT) {
    if (key !== "fill" && paint[key] !== undefined) out[key] = paint[key];
  }
  if ((out.stroke ?? "none") === "none") {
    for (const key of Object.keys(out)) {
      if (key.startsWith("stroke")) delete out[key];
    }
  }
  if (out["stroke-dasharray"] === "none") delete out["stroke-dasharray"];
  return Object.entries(out)
    .map(([k, v]) => `${k}:${rnd(v)}`)
    .join(";");
}

const num = (el, key) => Number(el.getAttribute(key) ?? 0);

/** A path for the shapes the set uses, or null for anything else. */
function shape(el, tag) {
  if (tag === "path") return el.getAttribute("d");
  if (tag === "circle") {
    const [cx, cy, r] = [num(el, "cx"), num(el, "cy"), num(el, "r")];
    return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  }
  if (tag === "rect") {
    const [x, y, w, h] = [
      num(el, "x"),
      num(el, "y"),
      num(el, "width"),
      num(el, "height"),
    ];
    const rx = Math.min(
      Number(el.getAttribute("rx") ?? el.getAttribute("ry") ?? 0),
      w / 2,
      h / 2,
    );
    if (!rx) return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
    return (
      `M${x + rx} ${y} H${x + w - rx} a${rx} ${rx} 0 0 1 ${rx} ${rx} V${y + h - rx} ` +
      `a${rx} ${rx} 0 0 1 ${-rx} ${rx} H${x + rx} a${rx} ${rx} 0 0 1 ${-rx} ${-rx} ` +
      `V${y + rx} a${rx} ${rx} 0 0 1 ${rx} ${-rx} Z`
    );
  }
  return null;
}

function walk(el, transforms, inherited, out, ids) {
  const tag = el.localName;
  if (SKIPPED.has(tag)) return;
  const t = el.getAttribute("transform");
  const chain = t ? [...transforms, rnd(t)] : transforms;
  const paint = paintOf(el, inherited);
  if (tag === "use") {
    const ref = el.getAttributeNS(XLINK, "href") ?? el.getAttribute("href");
    const target = ids.get((ref ?? "").replace(/^#/, ""));
    const [x, y] = [num(el, "x"), num(el, "y")];
    if (target) {
      const moved = x || y ? [...chain, `translate(${x} ${y})`] : chain;
      walk(target, moved, paint, out, ids);
    }
    return;
  }
  const d = shape(el, tag);
  if (d) {
    if (visible(paint)) {
      out.push({ d: rnd(d), s: styleOf(paint), t: chain.join(" ") });
    }
    return;
  }
  if (!["svg", "g", "a"].includes(tag)) {
    console.error("skipped element", tag);
    return;
  }
  for (const child of el.children) walk(child, chain, paint, out, ids);
}

function pack(file) {
  const raw = readFileSync(file, "utf8");
  if (/<!(DOCTYPE|ENTITY)/i.test(raw)) {
    throw new Error(`${file} declares a DTD; refusing to parse it`);
  }
  const root = new JSDOM(raw, { contentType: "image/svg+xml" }).window.document
    .documentElement;
  const ids = new Map(
    [...root.querySelectorAll("[id]")].map((el) => [el.getAttribute("id"), el]),
  );
  const paths = [];
  walk(root, [], {}, paths, ids);
  return { vb: rnd(root.getAttribute("viewBox") ?? "0 0 1 1"), paths };
}

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: node ui/scripts/packK8sIcons.mjs <icon dir> <out.ts>");
  process.exit(2);
}
const icons = Object.fromEntries(
  NAMES.map((name) => [name, pack(`${dir}/${name}.svg`)]),
);
for (const name of NAMES) console.error(name, icons[name].paths.length);
writeFileSync(
  out,
  [
    "// The Kubernetes Icons Set's unlabeled resource icons. Copyright The Kubernetes Authors,",
    "// Apache-2.0: see THIRD_PARTY_NOTICES.md. Packed by ui/scripts/packK8sIcons.mjs; do not",
    "// edit by hand.",
    "",
    `export type K8sIconName = ${NAMES.map((n) => JSON.stringify(n)).join(" | ")};`,
    "",
    "/** One path: its data, its paint as a style string, and its transforms. */",
    "export interface IconPath {",
    "  d: string;",
    "  s: string;",
    "  t: string;",
    "}",
    "",
    "export interface PackedIcon {",
    "  vb: string;",
    "  paths: IconPath[];",
    "}",
    "",
    `export const K8S_ICONS: Readonly<Record<K8sIconName, PackedIcon>> = ${JSON.stringify(icons, null, 2)};`,
    "",
  ].join("\n"),
);
