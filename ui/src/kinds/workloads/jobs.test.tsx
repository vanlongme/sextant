import { act, render, screen, within } from "@testing-library/react";
import { CirclePause, CirclePlay, Play } from "lucide-react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { OverviewSections } from "../../features/details/OverviewSections";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { CRONJOBS, JOBS } from "../refs";
import { type ActionContext, kindSpec } from "../registry";
import {
  CronJobDetail,
  cronStatus,
  JobDetail,
  jobCompletions,
  jobDurationText,
  jobResumeAction,
  jobStatus,
  jobSuspendAction,
  resumeAction,
  suspendAction,
  triggerAction,
} from "./jobs";

beforeEach(() => resetResourcesForTest());
afterEach(() => {
  resetResourcesForTest();
  vi.restoreAllMocks();
});

const m = { name: "j" };
const cond = (type: string, status = "True") => ({
  status: { conditions: [{ type, status }] },
});

test.each([
  ["complete", { metadata: m, ...cond("Complete") }, "Complete", "ok"],
  ["failed", { metadata: m, ...cond("Failed") }, "Failed", "danger"],
  [
    "a false condition does not count",
    { metadata: m, ...cond("Complete", "False") },
    "Running",
    "info",
  ],
  [
    "terminating",
    { metadata: { ...m, deletionTimestamp: "x" } },
    "Terminating",
    "neutral",
  ],
  [
    "complete wins over terminating",
    { metadata: { ...m, deletionTimestamp: "x" }, ...cond("Complete") },
    "Complete",
    "ok",
  ],
  ["suspended", { metadata: m, ...cond("Suspended") }, "Suspended", "warn"],
  [
    "failure target",
    { metadata: m, ...cond("FailureTarget") },
    "FailureTarget",
    "danger",
  ],
  [
    "success criteria met",
    { metadata: m, ...cond("SuccessCriteriaMet") },
    "SuccessCriteriaMet",
    "info",
  ],
  ["nothing yet", { metadata: m }, "Running", "info"],
])("job %s", (_n, object, label, tone) => {
  expect(jobStatus(object)).toEqual({ label, tone });
});

test("completions read like kubectl", () => {
  expect(
    jobCompletions({
      metadata: m,
      spec: { completions: 3 },
      status: { succeeded: 1 },
    }),
  ).toBe("1/3");
  expect(jobCompletions({ metadata: m, spec: { parallelism: 2 } })).toBe(
    "0/1 of 2",
  );
  expect(jobCompletions({ metadata: m, spec: { parallelism: 1 } })).toBe("0/1");
  expect(jobCompletions({ metadata: m })).toBe("0/1");
});

test("duration runs to now, or stops at completion", () => {
  const now = Date.parse("2026-01-01T00:02:00Z");
  const startTime = "2026-01-01T00:00:00Z";
  expect(jobDurationText({ metadata: m, status: { startTime } }, now)).toBe(
    "2m",
  );
  expect(
    jobDurationText(
      {
        metadata: m,
        status: { startTime, completionTime: "2026-01-01T00:00:30Z" },
      },
      now,
    ),
  ).toBe("30s");
  expect(jobDurationText({ metadata: m }, now)).toBe("");
});

test("cron status", () => {
  expect(cronStatus({ metadata: m, spec: { suspend: true } })).toEqual({
    label: "Suspended",
    tone: "warn",
  });
  expect(
    cronStatus({ metadata: m, status: { active: [{ name: "a" }] } }),
  ).toEqual({ label: "Active", tone: "info" });
  expect(cronStatus({ metadata: m })).toEqual({
    label: "Scheduled",
    tone: "ok",
  });
});

test("only the action that applies is offered", () => {
  const suspended = { metadata: m, spec: { suspend: true } };
  const running = { metadata: m, spec: { suspend: false } };
  expect(suspendAction.visible?.(suspended)).toBe(false);
  expect(resumeAction.visible?.(suspended)).toBe(true);
  expect(suspendAction.visible?.(running)).toBe(true);
  expect(resumeAction.visible?.(running)).toBe(false);
});

function context(confirmed: boolean): ActionContext {
  return {
    clusterId: "c",
    resource: CRONJOBS,
    navigate: () => {},
    confirm: async () => confirmed,
    openEditor: () => {},
    dialog: () => {},
  };
}

test("trigger asks first, creates the job and names it", async () => {
  const backend = mockBackend({ cronjob_trigger: () => "tick-manual-abcde" });
  const success = vi.spyOn(toast, "success");
  await triggerAction.run(context(true), {
    metadata: { name: "tick", namespace: "n" },
  });
  expect(backend.callsTo("cronjob_trigger")[0]).toMatchObject({
    namespace: "n",
    name: "tick",
  });
  expect(success).toHaveBeenCalledWith("Created job tick-manual-abcde");
});

test("trigger does nothing when the answer is no", async () => {
  const backend = mockBackend({ cronjob_trigger: () => "x" });
  await triggerAction.run(context(false), {
    metadata: { name: "tick", namespace: "n" },
  });
  expect(backend.callsTo("cronjob_trigger")).toHaveLength(0);
});

test("suspend and resume patch the CronJob flag and say so", async () => {
  const backend = mockBackend({ cronjob_set_suspend: () => null });
  const success = vi.spyOn(toast, "success");
  const object = { metadata: { name: "tick", namespace: "n" } };
  await suspendAction.run(context(true), object);
  await resumeAction.run(context(true), object);
  const calls = backend.callsTo("cronjob_set_suspend");
  expect(calls[0]).toMatchObject({ name: "tick", suspend: true });
  expect(calls[1]).toMatchObject({ name: "tick", suspend: false });
  expect(success.mock.calls).toEqual([["Suspended tick"], ["Resumed tick"]]);
});

test("a Job is suspended and resumed through its own command", async () => {
  const backend = mockBackend({ job_set_suspend: () => null });
  const success = vi.spyOn(toast, "success");
  const object = { metadata: { name: "batch", namespace: "n" } };
  await jobSuspendAction.run(context(true), object);
  await jobResumeAction.run(context(true), object);
  const calls = backend.callsTo("job_set_suspend");
  expect(calls[0]).toMatchObject({
    clusterId: "c",
    namespace: "n",
    name: "batch",
    suspend: true,
  });
  expect(calls[1]).toMatchObject({ name: "batch", suspend: false });
  expect(success.mock.calls).toEqual([["Suspended batch"], ["Resumed batch"]]);
});

test("a Job offers only the one that applies, and both need patch", () => {
  const suspended = { metadata: m, spec: { suspend: true } };
  const running = { metadata: m, spec: {} };
  expect(jobSuspendAction.visible?.(running)).toBe(true);
  expect(jobResumeAction.visible?.(running)).toBe(false);
  expect(jobSuspendAction.visible?.(suspended)).toBe(false);
  expect(jobResumeAction.visible?.(suspended)).toBe(true);
  expect([jobSuspendAction.requires, jobResumeAction.requires]).toEqual([
    "patch",
    "patch",
  ]);
  expect(kindSpec("batch", "jobs")?.actions?.map((a) => a.id)).toEqual([
    "logs",
    "suspend",
    "resume",
  ]);
});

test("the Job and CronJob actions carry the board's icons", () => {
  expect([triggerAction.icon, suspendAction.icon, resumeAction.icon]).toEqual([
    Play,
    CirclePause,
    CirclePlay,
  ]);
  expect([jobSuspendAction.icon, jobResumeAction.icon]).toEqual([
    CirclePause,
    CirclePlay,
  ]);
});

test("a job panel shows completions, parallelism, duration and its pods", async () => {
  let send: (e: WatchEvent) => void = () => {};
  mockBackend({
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub";
    },
    resources_unsubscribe: () => null,
  });
  const object = {
    metadata: { name: "j", namespace: "n" },
    spec: {
      completions: 3,
      parallelism: 2,
      selector: { matchLabels: { "job-name": "j" } },
    },
    status: {
      succeeded: 1,
      startTime: "2026-01-01T00:00:00Z",
      completionTime: "2026-01-01T00:00:30Z",
    },
  };
  render(
    <MemoryRouter>
      <JobDetail clusterId="c" object={object} resource={JOBS} resources={[]} />
    </MemoryRouter>,
  );
  await act(flush);
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        {
          metadata: {
            name: "mine",
            namespace: "n",
            labels: { "job-name": "j" },
          },
        },
        { metadata: { name: "unlabelled", namespace: "n" } },
      ],
    } as WatchEvent);
    await flush();
  });
  expect(screen.getByText("1/3")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  expect(screen.getByText("30s")).toBeTruthy();
  const pods = within(screen.getByTestId("detail-pods"));
  expect(pods.getByText("mine")).toBeTruthy();
  expect(pods.queryByText("unlabelled")).toBeNull();
});

test("a cronjob panel shows schedule, suspend, last schedule and active jobs as links", () => {
  const object = {
    metadata: { name: "tick", namespace: "n" },
    spec: { schedule: "*/5 * * * *", suspend: false },
    status: {
      lastScheduleTime: "2026-01-01T00:00:00Z",
      active: [{ kind: "Job", name: "tick-123", namespace: "n" }],
    },
  };
  const resources = [
    {
      resource: JOBS,
      verbs: ["list"],
      shortNames: [],
      canList: true,
      canWatch: true,
      canCreate: false,
      canUpdate: false,
      canPatch: false,
      canDelete: false,
    },
  ];
  render(
    <MemoryRouter>
      <CronJobDetail
        clusterId="c"
        object={object}
        resource={CRONJOBS}
        resources={resources}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("*/5 * * * *")).toBeTruthy();
  expect(screen.getByText("false")).toBeTruthy();
  expect(screen.getByText("Last schedule")).toBeTruthy();
  const link = screen.getByRole("link", { name: "Job tick-123" });
  expect(link.getAttribute("href")).toContain("tick-123");
});

function served(resource: ResourceRef): ApiResourceInfo {
  return {
    resource,
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

test("a Job and a CronJob list their Pod template's volumes and service account", async () => {
  mockBackend({
    resources_subscribe: () => "sub",
    resources_unsubscribe: () => null,
  });
  const template = {
    spec: {
      serviceAccountName: "runner",
      volumes: [{ name: "scratch", emptyDir: {} }],
      containers: [
        {
          name: "task",
          volumeMounts: [{ name: "scratch", mountPath: "/work" }],
        },
      ],
    },
  };
  const cases: [ResourceRef, KubeObject][] = [
    [JOBS, { metadata: { name: "j", namespace: "n" }, spec: { template } }],
    [
      CRONJOBS,
      {
        metadata: { name: "c", namespace: "n" },
        spec: { schedule: "*/5 * * * *", jobTemplate: { spec: { template } } },
      },
    ],
  ];
  const resources = [
    served(JOBS),
    served(CRONJOBS),
    served({
      group: "",
      version: "v1",
      plural: "serviceaccounts",
      kind: "ServiceAccount",
      namespaced: true,
    }),
  ];
  for (const [resource, object] of cases) {
    const view = render(
      <MemoryRouter>
        <OverviewSections
          clusterId="c"
          resource={resource}
          object={object}
          resources={resources}
          columns={
            kindSpec(resource.group, resource.plural)?.columns?.(
              served(resource),
            ) ?? []
          }
        />
      </MemoryRouter>,
    );
    await act(flush);
    const volume = within(screen.getByTestId("detail-volume-scratch"));
    expect(volume.getByText("EmptyDir")).toBeTruthy();
    expect(volume.getByText("Node disk")).toBeTruthy();
    const relations = within(screen.getByTestId("detail-relations"));
    expect(relations.getByText("None")).toBeTruthy();
    expect(relations.getByRole("link", { name: "runner" })).toBeTruthy();
    view.unmount();
  }
});
