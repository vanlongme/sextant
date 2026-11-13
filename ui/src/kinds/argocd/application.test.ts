import { describe, expect, it } from "vitest";
import {
  appHistory,
  appResources,
  appSources,
  autoSync,
  autoSyncText,
  canTerminate,
  deletesResources,
  destinationText,
  healthStatus,
  initiatedByText,
  isDeleting,
  isMultiSource,
  lastOperation,
  operationNote,
  projectLocation,
  refreshRequested,
  revisionText,
  revisionTitle,
  rollbackRefusal,
  rollbackTargets,
  shortRevision,
  syncStatus,
} from "./application";
import { NONE, type Obj } from "./common";

const SHA_A = "4f2c9a1d0b6e8f7a3c5d9e1b2a4c6e8f0a1b3c5d";
const SHA_B = "9b07e3d2c4a6b8d0e2f4a6c8e0b2d4f6a8c0e2b4";
const NOW = Date.parse("2026-11-14T12:00:00Z");

function app(over: Partial<Obj> = {}): Obj {
  return { metadata: { name: "web", namespace: "argocd" }, ...over };
}

describe("syncStatus and healthStatus", () => {
  it("map the Argo CD values to tones, and missing to Unknown", () => {
    const sync = (status?: string) =>
      syncStatus(app({ status: { sync: { status } } }));
    expect(sync("Synced")).toEqual({ label: "Synced", tone: "ok" });
    expect(sync("OutOfSync")).toEqual({ label: "OutOfSync", tone: "warn" });
    expect(sync("Weird")).toEqual({ label: "Weird", tone: "neutral" });
    expect(syncStatus(app())).toEqual({ label: "Unknown", tone: "neutral" });
    const health = (status?: string) =>
      healthStatus(app({ status: { health: { status } } }));
    expect(health("Healthy").tone).toBe("ok");
    expect(health("Progressing").tone).toBe("warn");
    expect(health("Degraded").tone).toBe("danger");
    for (const s of ["Suspended", "Missing", "Unknown", "constructor"]) {
      expect(health(s)).toEqual({ label: s, tone: "neutral" });
    }
    expect(healthStatus(app())).toEqual({ label: "Unknown", tone: "neutral" });
  });
});

describe("revisions", () => {
  it("shorten a 40-hex SHA only", () => {
    expect(shortRevision(SHA_A)).toBe("4f2c9a1");
    expect(shortRevision("v1.2.3")).toBe("v1.2.3");
    expect(shortRevision("4f2c9a1")).toBe("4f2c9a1");
  });
  it("read revision, else revisions with +N, else NONE", () => {
    expect(revisionText(app({ status: { sync: { revision: SHA_A } } }))).toBe(
      "4f2c9a1",
    );
    const multi = app({
      status: { sync: { revisions: [SHA_A, "1.4.0", SHA_B] } },
    });
    expect(revisionText(multi)).toBe("4f2c9a1 +2");
    expect(revisionTitle(multi)).toBe(`${SHA_A}, 1.4.0, ${SHA_B}`);
    expect(revisionText(app())).toBe(NONE);
  });
});

describe("sources and destination", () => {
  it("reads one source, or several, skipping entries without repoURL", () => {
    const one = app({
      spec: {
        source: { repoURL: "https://git.example.test/a.git", path: "web" },
      },
    });
    expect(isMultiSource(one)).toBe(false);
    expect(appSources(one)).toEqual([
      {
        repoURL: "https://git.example.test/a.git",
        pathOrChart: "web",
        targetRevision: "HEAD",
        ref: undefined,
      },
    ]);
    const many = app({
      spec: {
        source: { repoURL: "ignored" },
        sources: [
          {
            repoURL: "https://charts.example.test",
            chart: "redis",
            targetRevision: "19.0.1",
          },
          {
            repoURL: "https://git.example.test/values.git",
            targetRevision: "main",
            ref: "values",
          },
          { path: "no-repo" },
        ],
      },
    });
    expect(isMultiSource(many)).toBe(true);
    expect(appSources(many)).toEqual([
      {
        repoURL: "https://charts.example.test",
        pathOrChart: "redis",
        targetRevision: "19.0.1",
        ref: undefined,
      },
      {
        repoURL: "https://git.example.test/values.git",
        pathOrChart: NONE,
        targetRevision: "main",
        ref: "values",
      },
    ]);
  });
  it("names the destination by name, else server, with its namespace", () => {
    const dest = (destination: unknown) =>
      destinationText(app({ spec: { destination } }));
    expect(dest({ name: "in-cluster", namespace: "shop" })).toBe(
      "in-cluster, namespace shop",
    );
    expect(dest({ server: "https://kubernetes.default.svc" })).toBe(
      "https://kubernetes.default.svc",
    );
    expect(dest({ namespace: "shop" })).toBe(`${NONE}, namespace shop`);
    expect(dest(undefined)).toBe(NONE);
  });
});

describe("autoSync", () => {
  it("is on when automated is present and enabled is not false", () => {
    const policy = (automated: unknown) =>
      app({ spec: { syncPolicy: { automated } } });
    expect(autoSync(app()).on).toBe(false);
    expect(autoSync(policy({})).on).toBe(true);
    expect(autoSync(policy({ enabled: false, prune: true })).on).toBe(false);
    expect(autoSyncText(policy({ enabled: false, prune: true }))).toBe("Off");
    expect(autoSyncText(policy({}))).toBe("On");
    expect(autoSyncText(policy({ prune: true }))).toBe("On, prune");
    expect(autoSyncText(policy({ selfHeal: true }))).toBe("On, self-heal");
    expect(autoSyncText(policy({ prune: true, selfHeal: true }))).toBe(
      "On, prune, self-heal",
    );
  });
});

describe("projectLocation", () => {
  it("uses spec.project or default, where the controller runs or beside the Application", () => {
    expect(projectLocation(app())).toEqual({
      namespace: "argocd",
      name: "default",
    });
    expect(projectLocation(app({ spec: { project: "" } })).name).toBe(
      "default",
    );
    expect(
      projectLocation(
        app({
          spec: { project: "team" },
          status: { controllerNamespace: "argo-system" },
        }),
      ),
    ).toEqual({ namespace: "argo-system", name: "team" });
  });
});

describe("deleting and refresh", () => {
  it("reads the deletion, the resources finalizer and the refresh annotation", () => {
    const deleting = app({
      metadata: {
        name: "web",
        namespace: "argocd",
        deletionTimestamp: "2026-11-14T11:00:00Z",
        finalizers: ["resources-finalizer.argocd.argoproj.io/background"],
      } as Obj["metadata"],
    });
    expect(isDeleting(deleting)).toBe(true);
    expect(deletesResources(deleting)).toBe(true);
    expect(isDeleting(app())).toBe(false);
    expect(deletesResources(app())).toBe(false);
    const annotated = (value: string) =>
      app({
        metadata: {
          name: "web",
          annotations: { "argocd.argoproj.io/refresh": value },
        },
      });
    expect(refreshRequested(annotated("hard"))).toBe("Hard");
    expect(refreshRequested(annotated("normal"))).toBe("Normal");
    expect(refreshRequested(app())).toBeNull();
  });
});

describe("operations", () => {
  const running = app({
    operation: { sync: {}, initiatedBy: { username: "ci-bot" } },
    status: {
      operationState: { phase: "Running", startedAt: "2026-11-14T11:55:00Z" },
    },
  });
  it("describes a running, terminating and waiting operation", () => {
    expect(operationNote(running, NOW)).toBe(
      "An operation has been running for 5m, started by ci-bot. Terminate stops it.",
    );
    expect(
      operationNote(
        app({ status: { operationState: { phase: "Terminating" } } }),
        NOW,
      ),
    ).toBe("The running operation is terminating.");
    expect(operationNote(app({ operation: { sync: {} } }), NOW)).toBe(
      "An operation is waiting for the Argo CD controller to start it.",
    );
    expect(
      operationNote(
        app({ status: { operationState: { phase: "Succeeded" } } }),
        NOW,
      ),
    ).toBeNull();
  });
  it("can terminate only with an operation and an operation state, as the backend", () => {
    expect(canTerminate(running)).toBe(true);
    expect(canTerminate(app({ operation: { sync: {} } }))).toBe(false);
    expect(canTerminate(app({ operation: { sync: {} }, status: {} }))).toBe(
      false,
    );
    expect(
      canTerminate(
        app({
          operation: null,
          status: { operationState: { phase: "Running" } },
        }),
      ),
    ).toBe(false);
    expect(
      canTerminate(
        app({
          operation: { sync: {} },
          status: { operationState: { phase: "Succeeded" } },
        }),
      ),
    ).toBe(true);
  });
  it("names who started it", () => {
    expect(initiatedByText({ automated: true, username: "x" })).toBe(
      "Automated",
    );
    expect(initiatedByText({ username: "admin" })).toBe("admin");
    expect(initiatedByText(undefined)).toBe(NONE);
  });
  it("reads the last operation", () => {
    expect(lastOperation(app())).toBeNull();
    expect(
      lastOperation(
        app({
          status: {
            operationState: {
              phase: "Succeeded",
              message: "successfully synced",
              startedAt: "2026-11-14T10:00:00Z",
              finishedAt: "2026-11-14T10:00:30Z",
              operation: { initiatedBy: { automated: true } },
            },
          },
        }),
      ),
    ).toEqual({
      phase: "Succeeded",
      message: "successfully synced",
      startedAt: "2026-11-14T10:00:00Z",
      finishedAt: "2026-11-14T10:00:30Z",
      initiatedBy: "Automated",
    });
  });
});

describe("history and rollback", () => {
  const withHistory = (over: Partial<Obj> = {}) =>
    app({
      status: {
        history: [
          {
            id: 2,
            revision: SHA_B,
            deployedAt: "2026-11-13T10:00:00Z",
            initiatedBy: { username: "admin" },
          },
          {
            id: 3,
            revisions: [SHA_A, "1.4.0"],
            deployedAt: "2026-11-14T10:00:00Z",
          },
          {
            id: 1,
            revision: "v1.0.0",
            deployedAt: "2026-11-12T10:00:00Z",
            initiatedBy: { automated: true },
          },
          { revision: "no-id" },
        ],
      },
      ...over,
    });
  it("lists history newest first by id", () => {
    expect(appHistory(withHistory())).toEqual([
      {
        id: 3,
        revision: "4f2c9a1 +1",
        deployedAt: "2026-11-14T10:00:00Z",
        initiatedBy: NONE,
      },
      {
        id: 2,
        revision: "9b07e3d",
        deployedAt: "2026-11-13T10:00:00Z",
        initiatedBy: "admin",
      },
      {
        id: 1,
        revision: "v1.0.0",
        deployedAt: "2026-11-12T10:00:00Z",
        initiatedBy: "Automated",
      },
    ]);
    expect(rollbackTargets(withHistory()).map((h) => h.id)).toEqual([2, 1]);
  });
  it("refuses a roll back with auto-sync on or nothing earlier", () => {
    expect(rollbackRefusal(withHistory())).toBeNull();
    expect(
      rollbackRefusal(withHistory({ spec: { syncPolicy: { automated: {} } } })),
    ).toBe("Auto-sync is on. Turn it off before rolling back.");
    expect(
      rollbackRefusal(app({ status: { history: [{ id: 1, revision: "a" }] } })),
    ).toBe("There is no earlier deployment to roll back to.");
  });
});

describe("appResources", () => {
  it("reads kind, name, sync and health, with NONE for missing health", () => {
    expect(
      appResources(
        app({
          status: {
            resources: [
              {
                group: "apps",
                version: "v1",
                kind: "Deployment",
                namespace: "shop",
                name: "web",
                status: "Synced",
                health: { status: "Healthy" },
              },
              {
                version: "v1",
                kind: "Service",
                namespace: "shop",
                name: "web",
                status: "OutOfSync",
              },
              { kind: "Broken" },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        namespace: "shop",
        name: "web",
        sync: "Synced",
        health: "Healthy",
      },
      {
        apiVersion: "v1",
        kind: "Service",
        namespace: "shop",
        name: "web",
        sync: "OutOfSync",
        health: NONE,
      },
    ]);
  });
});

it("never throws on junk", () => {
  const junk = app({
    spec: {
      source: 5,
      sources: "x",
      destination: 7,
      syncPolicy: { automated: "yes" },
      project: 3,
    },
    status: {
      sync: { revision: 9, revisions: [1, null] },
      health: 4,
      history: [null, 5, { id: "1" }],
      resources: [null, 3],
      operationState: "x",
    },
    operation: 7,
  });
  for (const read of [
    syncStatus,
    healthStatus,
    revisionText,
    revisionTitle,
    isMultiSource,
    appSources,
    destinationText,
    autoSync,
    autoSyncText,
    projectLocation,
    isDeleting,
    deletesResources,
    refreshRequested,
    canTerminate,
    lastOperation,
    appHistory,
    rollbackTargets,
    rollbackRefusal,
    appResources,
  ]) {
    expect(() => read(junk)).not.toThrow();
  }
  expect(() => operationNote(junk, NOW)).not.toThrow();
});
