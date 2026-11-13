import { expect, it } from "vitest";
import {
  belongsTo,
  destinationsText,
  destinationsTitle,
  projectDestinations,
  sourceReposText,
  sourceReposTitle,
  syncWindows,
} from "./appProject";
import { NONE, type Obj } from "./common";

const project = (over: Partial<Obj> = {}): Obj => ({
  metadata: { name: "platform", namespace: "argocd" },
  ...over,
});

it("reads destinations and source repositories", () => {
  const o = project({
    spec: {
      destinations: [
        { server: "https://kubernetes.default.svc", namespace: "edge" },
        { name: "in-cluster", namespace: "observability" },
        { namespace: "edge" },
        {},
      ],
      sourceRepos: [
        "https://git.example.test/platform/*",
        "http://charts.example.test",
        "*",
      ],
    },
  });
  expect(projectDestinations(o)).toEqual([
    { target: "https://kubernetes.default.svc", namespace: "edge" },
    { target: "in-cluster", namespace: "observability" },
    { target: "*", namespace: "edge" },
    { target: "*", namespace: "*" },
  ]);
  expect(destinationsText(o)).toBe("edge +2");
  expect(destinationsTitle(o)).toBe("edge, observability, *");
  expect(sourceReposText(o)).toBe("git.example.test/platform/* +2");
  expect(sourceReposTitle(o)).toBe(
    "git.example.test/platform/*, charts.example.test, *",
  );
  expect(destinationsText(project())).toBe(NONE);
  expect(sourceReposText(project())).toBe(NONE);
});

it("reads sync windows with their scope", () => {
  const o = project({
    spec: {
      syncWindows: [
        {
          kind: "deny",
          schedule: "0 22 * * *",
          duration: "1h",
          applications: ["*"],
          namespaces: ["edge"],
          manualSync: true,
          timeZone: "Europe/Paris",
        },
        {
          kind: "allow",
          schedule: "0 6 * * 1-5",
          duration: "10h",
          clusters: ["in-cluster"],
        },
        {},
      ],
    },
  });
  expect(syncWindows(o)).toEqual([
    {
      kind: "deny",
      schedule: "0 22 * * *",
      duration: "1h",
      timeZone: "Europe/Paris",
      scope: "Applications: *; Namespaces: edge",
      manualSync: true,
    },
    {
      kind: "allow",
      schedule: "0 6 * * 1-5",
      duration: "10h",
      timeZone: undefined,
      scope: "Clusters: in-cluster",
      manualSync: false,
    },
    {
      kind: NONE,
      schedule: NONE,
      duration: NONE,
      timeZone: undefined,
      scope: NONE,
      manualSync: false,
    },
  ]);
  expect(syncWindows(project())).toEqual([]);
});

it("an Application belongs to the project at its project location", () => {
  const app = (spec: unknown, status?: unknown): Obj => ({
    metadata: { name: "web", namespace: "argocd" },
    spec,
    status,
  });
  expect(belongsTo(app({ project: "platform" }), project())).toBe(true);
  expect(belongsTo(app({ project: "other" }), project())).toBe(false);
  expect(
    belongsTo(
      app({ project: "platform" }, { controllerNamespace: "argo-system" }),
      project(),
    ),
  ).toBe(false);
  expect(
    belongsTo(
      app({}),
      project({ metadata: { name: "default", namespace: "argocd" } }),
    ),
  ).toBe(true);
});
