import { expect, test } from "vitest";
import { chartsPath } from "../helm/helmText";
import { overviewPath, settingsPath } from "./paths";

test("the Overview and Settings paths encode the cluster id", () => {
  expect(overviewPath("c1")).toBe("/cluster/c1");
  expect(settingsPath("c1")).toBe("/cluster/c1/settings");
  expect(settingsPath("team a/prod")).toBe("/cluster/team%20a%2Fprod/settings");
});

test("they share their base with the Helm paths", () => {
  expect(
    chartsPath("team a/prod").startsWith(overviewPath("team a/prod")),
  ).toBe(true);
});
