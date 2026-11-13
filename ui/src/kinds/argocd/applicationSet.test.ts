import { expect, it } from "vitest";
import {
  generatedApps,
  generatedCount,
  generatorRows,
  generatorText,
  generatorTypes,
} from "./applicationSet";
import { NONE, type Obj } from "./common";

const set = (over: Partial<Obj> = {}): Obj => ({
  metadata: { name: "teams", namespace: "argocd" },
  ...over,
});

it("labels each generator by its first key, ignoring selector", () => {
  const o = set({
    spec: {
      generators: [
        { list: { elements: [{ a: 1 }, { a: 2 }] } },
        {
          selector: { matchLabels: {} },
          git: {
            repoURL: "https://git.example.test/d.git",
            revision: "main",
            directories: [{ path: "apps/*" }],
          },
        },
        { clusters: { selector: { matchLabels: { env: "prod" } } } },
        { matrix: { generators: [{ git: {} }, { list: {} }] } },
        { merge: { generators: [{ clusters: {} }, { list: {} }] } },
        { scmProvider: {} },
        { somethingNew: {} },
        "junk",
      ],
    },
  });
  expect(generatorTypes(o)).toEqual([
    "List",
    "Git",
    "Clusters",
    "Matrix",
    "Merge",
    "SCM provider",
    "somethingNew",
  ]);
  expect(generatorText(o)).toBe(
    "List, Git, Clusters, Matrix, Merge, SCM provider, somethingNew",
  );
  expect(generatorRows(o)).toEqual([
    { type: "List", summary: "2 elements" },
    {
      type: "Git",
      summary: "https://git.example.test/d.git @ main, directories apps/*",
    },
    { type: "Clusters", summary: "env=prod" },
    { type: "Matrix", summary: "Git × List" },
    { type: "Merge", summary: "Clusters + List" },
    { type: "SCM provider", summary: NONE },
    { type: "somethingNew", summary: NONE },
  ]);
  expect(generatorText(set())).toBe(NONE);
});

it("summarises git files, and clusters with no selector", () => {
  const o = set({
    spec: {
      generators: [
        {
          git: {
            repoURL: "https://git.example.test/c.git",
            files: [{ path: "a.json" }, { path: "b.json" }],
          },
        },
        { clusters: {} },
      ],
    },
  });
  expect(generatorRows(o)).toEqual([
    {
      type: "Git",
      summary: "https://git.example.test/c.git @ HEAD, files a.json, b.json",
    },
    { type: "Clusters", summary: "All clusters" },
  ]);
});

it("reads the generated Applications from status.resources", () => {
  const o = set({
    status: {
      resources: [
        {
          kind: "Application",
          namespace: "argocd",
          name: "team-a",
          status: "Synced",
          health: { status: "Healthy" },
        },
        { kind: "Application", name: "team-b" },
        { kind: "ConfigMap", name: "x" },
      ],
    },
  });
  expect(generatedApps(o)).toEqual([
    { name: "team-a", namespace: "argocd", sync: "Synced", health: "Healthy" },
    { name: "team-b", namespace: undefined, sync: NONE, health: NONE },
  ]);
  expect(generatedCount(o)).toBe(3);
  expect(generatedCount(set())).toBeNull();
});
