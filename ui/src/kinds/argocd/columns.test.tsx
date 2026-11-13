import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../objects";
import { kindSpec } from "../registry";
import "./index";

function info(plural: string, kind: string): ApiResourceInfo {
  return {
    resource: {
      group: "argoproj.io",
      version: "v1alpha1",
      plural,
      kind,
      namespaced: true,
    },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

const columns = (plural: string, kind: string) =>
  kindSpec("argoproj.io", plural)?.columns?.(info(plural, kind)) ?? [];

/** One rendered cell; each call renders into its own container. */
function cell(
  plural: string,
  kind: string,
  id: string,
  o: KubeObject,
): HTMLElement {
  const column = columns(plural, kind).find((c) => c.id === id);
  if (!column) throw new Error(`no column ${id}`);
  return render(<div>{column.render(o)}</div>).container
    .firstElementChild as HTMLElement;
}

const meta = { name: "web", namespace: "argocd" };

it("Applications show Project, Sync, Health and Revision between Namespace and Age", () => {
  expect(columns("applications", "Application").map((c) => c.header)).toEqual([
    "Name",
    "Namespace",
    "Project",
    "Sync",
    "Health",
    "Revision",
    "Age",
  ]);
  const o: KubeObject = {
    metadata: meta,
    spec: {},
    status: {
      sync: {
        status: "OutOfSync",
        revision: "4f2c9a1d0b6e8f7a3c5d9e1b2a4c6e8f0a1b3c5d",
      },
      health: { status: "Degraded" },
    },
  };
  expect(cell("applications", "Application", "project", o).textContent).toBe(
    "default",
  );
  expect(cell("applications", "Application", "sync", o).textContent).toBe(
    "OutOfSync",
  );
  const revision = cell("applications", "Application", "revision", o);
  expect(revision.textContent).toBe("4f2c9a1");
  expect(revision.querySelector("span")?.getAttribute("title")).toBe(
    "4f2c9a1d0b6e8f7a3c5d9e1b2a4c6e8f0a1b3c5d",
  );
});

it("ApplicationSets show Generators and the number of Applications", () => {
  expect(
    columns("applicationsets", "ApplicationSet").map((c) => c.header),
  ).toEqual(["Name", "Namespace", "Generators", "Applications", "Age"]);
  const o: KubeObject = {
    metadata: meta,
    spec: { generators: [{ list: {} }, { git: {} }] },
    status: { resources: [{}, {}, {}] },
  };
  expect(
    cell("applicationsets", "ApplicationSet", "generators", o).textContent,
  ).toBe("List, Git");
  expect(
    cell("applicationsets", "ApplicationSet", "applications", o).textContent,
  ).toBe("3");
});

it("ApplicationSets without status.resources show — for Applications", () => {
  expect(
    cell("applicationsets", "ApplicationSet", "applications", {
      metadata: meta,
    }).textContent,
  ).toBe("—");
});

it("AppProjects show Destinations and Sources with the full list as a title", () => {
  expect(columns("appprojects", "AppProject").map((c) => c.header)).toEqual([
    "Name",
    "Namespace",
    "Destinations",
    "Sources",
    "Age",
  ]);
  const o: KubeObject = {
    metadata: meta,
    spec: {
      destinations: [{ namespace: "edge" }, { namespace: "observability" }],
      sourceRepos: ["https://git.example.test/platform/*"],
    },
  };
  const destinations = cell("appprojects", "AppProject", "destinations", o);
  expect(destinations.textContent).toBe("edge +1");
  expect(destinations.querySelector("span")?.getAttribute("title")).toBe(
    "edge, observability",
  );
  expect(cell("appprojects", "AppProject", "sources", o).textContent).toBe(
    "git.example.test/platform/*",
  );
});
