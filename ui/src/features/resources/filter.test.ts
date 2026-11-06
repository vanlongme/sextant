import { expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import { matchesSearch } from "./filter";

const web: KubeObject = {
  metadata: {
    name: "web-1",
    namespace: "Team-A",
    labels: { app: "web", tier: "Front", "k8s.io/role": "edge" },
  },
};
const node: KubeObject = { metadata: { name: "node-1" } };

test("an empty query matches everything", () => {
  expect(matchesSearch(web, "")).toBe(true);
  expect(matchesSearch(node, "   ")).toBe(true);
});

test("matches the name", () => {
  expect(matchesSearch(web, "web-")).toBe(true);
  expect(matchesSearch(web, "absent")).toBe(false);
});

test("matches the namespace", () => {
  expect(matchesSearch(web, "team-a")).toBe(true);
  expect(matchesSearch(node, "team-a")).toBe(false);
});

test("matches a label key or value", () => {
  expect(matchesSearch(web, "tier")).toBe(true);
  expect(matchesSearch(web, "front")).toBe(true);
  expect(matchesSearch(node, "front")).toBe(false);
});

test("k=v matches a label with that key and value", () => {
  expect(matchesSearch(web, "app=web")).toBe(true);
  expect(matchesSearch(web, "k8s.io/role=edge")).toBe(true);
  // Each side has to match the whole of its part.
  expect(matchesSearch(web, "app=we")).toBe(false);
  expect(matchesSearch(web, "ap=web")).toBe(false);
  expect(matchesSearch(web, "tier=web")).toBe(false);
  expect(matchesSearch(node, "app=web")).toBe(false);
});

test("terms separated by spaces must all match", () => {
  expect(matchesSearch(web, "web team-a")).toBe(true);
  expect(matchesSearch(web, "web   app=web  front")).toBe(true);
  expect(matchesSearch(web, "web team-b")).toBe(false);
  expect(matchesSearch(web, "app=web tier=back")).toBe(false);
});

test("matching ignores case", () => {
  expect(matchesSearch(web, "WEB-1")).toBe(true);
  expect(matchesSearch(web, "TEAM-a")).toBe(true);
  expect(matchesSearch(web, "TIER=front")).toBe(true);
});

test("an object without labels or a namespace is fine", () => {
  expect(matchesSearch(node, "node")).toBe(true);
  expect(matchesSearch(node, "k=v")).toBe(false);
});
