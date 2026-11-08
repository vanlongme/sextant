import { CirclePause, CirclePlay, Play } from "lucide-react";
import { toast, useNow } from "../../design";
import { api } from "../../ipc/api";
import {
  baseColumns,
  numberColumn,
  type StatusInfo,
  statusColumn,
  textColumn,
} from "../columns";
import { Chips, Facts, ObjectLink, Part } from "../detail/parts";
import { formatAge, type KubeObject } from "../objects";
import {
  ageSortValue,
  type DetailProps,
  type KindAction,
  registerKind,
} from "../registry";
import { matchesSelector, selectorText } from "../selectors";
import { PodList } from "./PodList";

const holds = (o: KubeObject, type: string) =>
  (o.status?.conditions ?? []).some(
    (c: { type: string; status: string }) =>
      c.type === type && c.status === "True",
  );

/** The state of a Job in `kubectl`'s order; a condition counts only when it is `True`. */
export function jobStatus(o: KubeObject): StatusInfo {
  if (holds(o, "Complete")) return { label: "Complete", tone: "ok" };
  if (holds(o, "Failed")) return { label: "Failed", tone: "danger" };
  if (o.metadata.deletionTimestamp)
    return { label: "Terminating", tone: "neutral" };
  if (holds(o, "Suspended")) return { label: "Suspended", tone: "warn" };
  if (holds(o, "FailureTarget"))
    return { label: "FailureTarget", tone: "danger" };
  if (holds(o, "SuccessCriteriaMet"))
    return { label: "SuccessCriteriaMet", tone: "info" };
  return { label: "Running", tone: "info" };
}

/** `succeeded/completions`, or `succeeded/1 of parallelism` for a work-queue Job. */
export function jobCompletions(o: KubeObject): string {
  const succeeded = o.status?.succeeded ?? 0;
  const completions = o.spec?.completions;
  if (typeof completions === "number") return `${succeeded}/${completions}`;
  const parallelism = o.spec?.parallelism;
  return typeof parallelism === "number" && parallelism > 1
    ? `${succeeded}/1 of ${parallelism}`
    : `${succeeded}/1`;
}

export function jobDurationText(o: KubeObject, now: number): string {
  const startTime = o.status?.startTime;
  if (!startTime) return "";
  const done = o.status?.completionTime;
  return formatAge(startTime, done ? Date.parse(done) : now);
}

export function cronStatus(o: KubeObject): StatusInfo {
  if (o.spec?.suspend) return { label: "Suspended", tone: "warn" };
  if ((o.status?.active ?? []).length > 0)
    return { label: "Active", tone: "info" };
  return { label: "Scheduled", tone: "ok" };
}

function Duration(props: { object: KubeObject }) {
  return <>{jobDurationText(props.object, useNow()) || "-"}</>;
}

function LastSchedule(props: { from: string | undefined }) {
  return <>{formatAge(props.from, useNow())}</>;
}

const durationMs = (o: KubeObject) => {
  const start = Date.parse(o.status?.startTime ?? "");
  if (Number.isNaN(start)) return 0;
  const end = Date.parse(o.status?.completionTime ?? "");
  return (Number.isNaN(end) ? Date.now() : end) - start;
};

// No `requires`: it creates a Job, and the row's access flags are for CronJobs.
export const triggerAction: KindAction = {
  id: "trigger",
  label: "Trigger",
  icon: Play,
  run: async (ctx, o) => {
    const { name, namespace = "" } = o.metadata;
    const yes = await ctx.confirm({
      title: `Trigger ${name}?`,
      body: "This creates a Job from its template now, outside its schedule.",
      confirmLabel: "Trigger",
    });
    if (!yes) return;
    const job = await api.cronjobTrigger(ctx.clusterId, namespace, name);
    toast.success(`Created job ${job}`);
  },
};

type SetSuspend = (
  clusterId: string,
  namespace: string,
  name: string,
  suspend: boolean,
) => Promise<void>;

// Each undoes the other, so neither asks first.
function suspendToggle(suspend: boolean, set: SetSuspend): KindAction {
  return {
    id: suspend ? "suspend" : "resume",
    label: suspend ? "Suspend" : "Resume",
    icon: suspend ? CirclePause : CirclePlay,
    requires: "patch",
    visible: (o) => Boolean(o.spec?.suspend) !== suspend,
    run: async (ctx, o) => {
      const { name, namespace = "" } = o.metadata;
      await set(ctx.clusterId, namespace, name, suspend);
      toast.success(`${suspend ? "Suspended" : "Resumed"} ${name}`);
    },
  };
}

const setCronJob: SetSuspend = (...args) => api.cronjobSetSuspend(...args);
const setJob: SetSuspend = (...args) => api.jobSetSuspend(...args);

export const suspendAction = suspendToggle(true, setCronJob);
export const resumeAction = suspendToggle(false, setCronJob);
export const jobSuspendAction = suspendToggle(true, setJob);
export const jobResumeAction = suspendToggle(false, setJob);

export function JobDetail({ clusterId, object }: DetailProps) {
  const spec = object.spec ?? {};
  const selector = selectorText(spec.selector);
  return (
    <>
      <Part title="Job" testId="detail-job">
        <Facts
          items={[
            ["Status", jobStatus(object).label],
            ["Completions", jobCompletions(object)],
            ["Parallelism", spec.parallelism?.toString()],
            ["Duration", <Duration key="d" object={object} />],
            ["Backoff limit", spec.backoffLimit?.toString()],
            [
              "Selector",
              selector.length > 0 ? (
                <Chips key="s" values={selector} />
              ) : undefined,
            ],
          ]}
        />
      </Part>
      <Part title="Pods">
        <PodList
          clusterId={clusterId}
          namespace={object.metadata.namespace}
          match={(p) => matchesSelector(p.metadata.labels, spec.selector)}
        />
      </Part>
    </>
  );
}

export function CronJobDetail({ clusterId, object, resources }: DetailProps) {
  const spec = object.spec ?? {};
  const active = (object.status?.active ?? []) as {
    name: string;
    namespace?: string;
  }[];
  return (
    <Part title="CronJob" testId="detail-cronjob">
      <Facts
        items={[
          ["Schedule", spec.schedule],
          ["Time zone", spec.timeZone],
          ["Suspend", String(Boolean(spec.suspend))],
          [
            "Last schedule",
            <LastSchedule key="l" from={object.status?.lastScheduleTime} />,
          ],
          ["Concurrency policy", spec.concurrencyPolicy],
          [
            "Active",
            active.length > 0 ? (
              <ul key="a">
                {active.map((job) => (
                  <li key={job.name}>
                    <ObjectLink
                      clusterId={clusterId}
                      resources={resources}
                      kind="Job"
                      name={job.name}
                      namespace={job.namespace ?? object.metadata.namespace}
                      apiVersion="batch/v1"
                    />
                  </li>
                ))}
              </ul>
            ) : undefined,
          ],
        ]}
      />
    </Part>
  );
}

registerKind("batch", "jobs", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("completions", "Completions", jobCompletions, { width: 110 }),
      statusColumn(jobStatus),
      {
        id: "duration",
        header: "Duration",
        width: 100,
        sortValue: durationMs,
        render: (o) => <Duration object={o} />,
      },
    ),
  actions: [jobSuspendAction, jobResumeAction],
  detail: JobDetail,
});

registerKind("batch", "cronjobs", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("schedule", "Schedule", (o) => o.spec?.schedule, {
        width: 130,
      }),
      textColumn("timeZone", "Time zone", (o) => o.spec?.timeZone, {
        defaultHidden: true,
      }),
      statusColumn(cronStatus),
      numberColumn("active", "Active", (o) => (o.status?.active ?? []).length),
      {
        id: "lastSchedule",
        header: "Last schedule",
        width: 120,
        sortValue: (o) => ageSortValue(o.status?.lastScheduleTime),
        render: (o) => <LastSchedule from={o.status?.lastScheduleTime} />,
      },
    ),
  actions: [triggerAction, suspendAction, resumeAction],
  detail: CronJobDetail,
});
