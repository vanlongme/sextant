import { expect, test } from "vitest";
import { clusterColor, clusterInitials } from "./clusterVisual";

test("initials use word boundaries", () => {
  expect(clusterInitials("prod-eu-west")).toBe("PE");
  expect(clusterInitials("kind-sextant-e2e")).toBe("KS");
  expect(clusterInitials("minikube")).toBe("MI");
  expect(clusterInitials("Ñandú prod")).toBe("ÑP");
  expect(clusterInitials("")).toBe("?");
});

test("initials never exceed two characters", () => {
  expect(clusterInitials("ßeta")).toBe("SS");
  expect(clusterInitials("--- ---")).toBe("?");
});

test("color is stable per id", () => {
  expect(clusterColor("abc")).toBe(clusterColor("abc"));
});

test("colors come from a palette of 8 and ids spread over it", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(clusterColor(`cluster-${i}`));
  expect(seen.size).toBe(8);
  expect(clusterColor("")).toMatch(/^#[0-9a-f]{6}$/);
});
