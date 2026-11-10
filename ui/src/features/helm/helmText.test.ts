import { expect, test } from "vitest";
import {
  ago,
  chartsPath,
  installPath,
  namespacePath,
  objectPath,
  parsePair,
  releaseActions,
  releasesPath,
  statusTone,
  upgradePath,
  utcTime,
  versionText,
} from "./helmText";

const NOW = Date.parse("2026-11-10T12:00:00Z");

test.each([
  ["deployed", "ok"],
  ["failed", "danger"],
  ["superseded", "neutral"],
  ["uninstalled", "neutral"],
  ["pending-install", "warn"],
  ["pending-upgrade", "warn"],
  ["pending-rollback", "warn"],
  ["uninstalling", "warn"],
  ["unknown", "neutral"],
])("status %s has tone %s", (status, tone) => {
  expect(statusTone(status)).toBe(tone);
});

test("times read as an age, and in UTC with the age", () => {
  expect(ago("2026-11-10T09:00:00Z", NOW)).toBe("3h ago");
  expect(ago(null, NOW)).toBe("—");
  expect(utcTime("2026-11-10T09:05:07Z", NOW)).toBe(
    "2026-11-10 09:05:07 UTC · 2h54m ago",
  );
  expect(utcTime(null, NOW)).toBe("—");
});

test("a missing version part drops out", () => {
  expect(versionText("1.2.3", "1.25.0")).toBe("1.2.3 · app 1.25.0");
  expect(versionText("1.2.3", null)).toBe("1.2.3");
  expect(versionText(null, "1.25.0")).toBe("app 1.25.0");
});

test("paths encode each part, and a pair parameter reads back", () => {
  expect(chartsPath("c 1")).toBe("/cluster/c%201/helm/charts");
  expect(chartsPath("c1", { repo: "bitnami", name: "nginx" })).toBe(
    "/cluster/c1/helm/charts?chart=bitnami%2Fnginx",
  );
  expect(releasesPath("c1", { namespace: "shop", name: "web" })).toBe(
    "/cluster/c1/helm/releases?release=shop%2Fweb",
  );
  // A part with a slash survives the round trip through the URL.
  const url = new URL(
    chartsPath("c1", { repo: "my/repo", name: "web" }),
    "http://x",
  );
  expect(parsePair(url.searchParams.get("chart"))).toEqual({
    first: "my/repo",
    second: "web",
  });
  expect(installPath("c1", "bitnami", "nginx")).toBe(
    "/cluster/c1/helm/install?repo=bitnami&chart=nginx",
  );
  expect(installPath("c1", "bitnami", "nginx", "1.2.3")).toBe(
    "/cluster/c1/helm/install?repo=bitnami&chart=nginx&version=1.2.3",
  );
  expect(upgradePath("c1", "shop", "web")).toBe(
    "/cluster/c1/helm/upgrade/shop/web",
  );
  expect(parsePair("my%2Frepo/web")).toEqual({
    first: "my/repo",
    second: "web",
  });
  expect(parsePair("a/b/c")).toBeNull();
  expect(parsePair("/web")).toBeNull();
  expect(parsePair("%E0/x")).toBeNull();
  expect(parsePair(null)).toBeNull();
});

test("object links follow the resource drawers' ?object= rule", () => {
  const configMaps = {
    group: "",
    version: "v1",
    plural: "configmaps",
    kind: "ConfigMap",
    namespaced: true,
  };
  expect(objectPath("c1", configMaps, "shop", "web-config")).toBe(
    "/cluster/c1/r/core/configmaps?object=shop%2Fweb-config",
  );
  expect(
    objectPath(
      "c1",
      { ...configMaps, plural: "clusterroles", namespaced: false },
      null,
      "admin",
    ),
  ).toBe("/cluster/c1/r/core/clusterroles?object=%2Fadmin");
  expect(namespacePath("c1", "shop")).toBe(
    "/cluster/c1/r/core/namespaces?object=%2Fshop",
  );
});

test("a busy release offers nothing, an uninstalled one only Uninstall", () => {
  expect(releaseActions({ status: "deployed" }, undefined, 2)).toEqual({
    upgrade: true,
    rollback: true,
    uninstall: true,
  });
  expect(releaseActions({ status: "deployed" }, undefined, 1).rollback).toBe(
    false,
  );
  expect(releaseActions({ status: "pending-upgrade" }, undefined, 3)).toEqual({
    upgrade: false,
    rollback: false,
    uninstall: false,
  });
  expect(releaseActions({ status: "uninstalled" }, undefined, 3)).toEqual({
    upgrade: false,
    rollback: false,
    uninstall: true,
  });
});
