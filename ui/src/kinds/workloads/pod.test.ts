import { describe, expect, test } from "vitest";
import { containersOf, envText, podStatus, podSummary, probeText } from "./pod";

const running = {
  state: { running: {} },
  ready: true,
  restartCount: 0,
  name: "a",
};
function pod(status: object, spec: object = {}, metadata: object = {}) {
  return {
    metadata: { name: "p", ...metadata },
    spec: { containers: [{ name: "a" }], ...spec },
    status,
  };
}

describe("podSummary follows kubectl", () => {
  test.each([
    ["phase", pod({ phase: "Pending" }), "Pending"],
    [
      "pod reason wins over phase",
      pod({ phase: "Failed", reason: "Evicted" }),
      "Evicted",
    ],
    [
      "scheduling gate",
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", reason: "SchedulingGated" }],
      }),
      "SchedulingGated",
    ],
    [
      "waiting reason",
      pod({
        phase: "Running",
        containerStatuses: [
          { state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      }),
      "CrashLoopBackOff",
    ],
    [
      "terminated reason",
      pod({
        phase: "Failed",
        containerStatuses: [
          { state: { terminated: { reason: "OOMKilled", exitCode: 137 } } },
        ],
      }),
      "OOMKilled",
    ],
    [
      "terminated by signal",
      pod({
        phase: "Failed",
        containerStatuses: [
          { state: { terminated: { signal: 9, exitCode: 0 } } },
        ],
      }),
      "Signal:9",
    ],
    [
      "terminated with a code",
      pod({
        phase: "Failed",
        containerStatuses: [{ state: { terminated: { exitCode: 3 } } }],
      }),
      "ExitCode:3",
    ],
    [
      "running",
      pod({ phase: "Running", containerStatuses: [running] }),
      "Running",
    ],
    [
      "completed with one still running and ready",
      pod({
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          running,
          { state: { terminated: { reason: "Completed", exitCode: 0 } } },
        ],
      }),
      "Running",
    ],
    [
      "completed with one running, pod not ready",
      pod({
        phase: "Running",
        containerStatuses: [
          running,
          { state: { terminated: { reason: "Completed", exitCode: 0 } } },
        ],
      }),
      "NotReady",
    ],
    [
      "init in progress",
      pod(
        {
          phase: "Pending",
          initContainerStatuses: [{ name: "i", state: { running: {} } }],
        },
        { initContainers: [{ name: "i" }, { name: "j" }] },
      ),
      "Init:0/2",
    ],
    [
      "init waiting",
      pod(
        {
          phase: "Pending",
          initContainerStatuses: [
            { name: "i", state: { waiting: { reason: "ImagePullBackOff" } } },
          ],
        },
        { initContainers: [{ name: "i" }] },
      ),
      "Init:ImagePullBackOff",
    ],
    [
      "init failed",
      pod(
        {
          phase: "Pending",
          initContainerStatuses: [
            {
              name: "i",
              state: { terminated: { reason: "Error", exitCode: 1 } },
            },
          ],
        },
        { initContainers: [{ name: "i" }] },
      ),
      "Init:Error",
    ],
    [
      "init failed by signal",
      pod(
        {
          phase: "Pending",
          initContainerStatuses: [
            { name: "i", state: { terminated: { signal: 9, exitCode: 137 } } },
          ],
        },
        { initContainers: [{ name: "i" }] },
      ),
      "Init:Signal:9",
    ],
    [
      "init failed with a code",
      pod(
        {
          phase: "Pending",
          initContainerStatuses: [
            { name: "i", state: { terminated: { exitCode: 2 } } },
          ],
        },
        { initContainers: [{ name: "i" }] },
      ),
      "Init:ExitCode:2",
    ],
    [
      "init done",
      pod(
        {
          phase: "Running",
          initContainerStatuses: [
            { name: "i", state: { terminated: { exitCode: 0 } } },
          ],
          containerStatuses: [running],
        },
        { initContainers: [{ name: "i" }] },
      ),
      "Running",
    ],
    [
      "terminating",
      pod(
        { phase: "Running", containerStatuses: [running] },
        {},
        { deletionTimestamp: "2026-01-01T00:00:00Z" },
      ),
      "Terminating",
    ],
    [
      "terminating on a lost node",
      pod(
        { phase: "Running", reason: "NodeLost" },
        {},
        { deletionTimestamp: "2026-01-01T00:00:00Z" },
      ),
      "Unknown",
    ],
    [
      "a finished pod being deleted keeps its status",
      pod(
        {
          phase: "Succeeded",
          containerStatuses: [
            { state: { terminated: { reason: "Completed", exitCode: 0 } } },
          ],
        },
        {},
        { deletionTimestamp: "2026-01-01T00:00:00Z" },
      ),
      "Completed",
    ],
  ])("%s", (_name, object, expected) => {
    expect(podSummary(object).status).toBe(expected);
  });

  test("a pod with nothing yet does not throw", () => {
    expect(podSummary({ metadata: { name: "p" } })).toEqual({
      status: "Unknown",
      ready: "0/0",
      restarts: 0,
    });
  });

  test("ready counts running and ready containers over the spec's containers", () => {
    const object = pod(
      { containerStatuses: [running, { ...running, ready: false }] },
      { containers: [{ name: "a" }, { name: "b" }] },
    );
    expect(podSummary(object).ready).toBe("1/2");
  });

  test("restarts add up regular containers once init is done", () => {
    const object = pod(
      {
        initContainerStatuses: [
          {
            name: "i",
            restartCount: 5,
            state: { terminated: { exitCode: 0 } },
          },
        ],
        containerStatuses: [
          { ...running, restartCount: 2 },
          { ...running, restartCount: 1 },
        ],
      },
      { initContainers: [{ name: "i" }] },
    );
    expect(podSummary(object).restarts).toBe(3);
  });

  test("a restartable init container counts towards ready and restarts", () => {
    const object = pod(
      {
        phase: "Running",
        initContainerStatuses: [
          {
            name: "side",
            restartCount: 4,
            started: true,
            ready: true,
            state: { running: {} },
          },
        ],
        containerStatuses: [{ ...running, restartCount: 1 }],
      },
      { initContainers: [{ name: "side", restartPolicy: "Always" }] },
    );
    expect(podSummary(object)).toMatchObject({
      ready: "2/2",
      restarts: 5,
      status: "Running",
    });
  });
});

describe("podStatus tones", () => {
  test.each([
    ["Running", "ok"],
    ["Completed", "ok"],
    ["Succeeded", "ok"],
    ["ContainerCreating", "info"],
    ["PodInitializing", "info"],
    ["Init:0/2", "info"],
    ["SchedulingGated", "info"],
    ["Pending", "warn"],
    ["NotReady", "warn"],
    ["Terminating", "neutral"],
    ["Unknown", "neutral"],
    ["CrashLoopBackOff", "danger"],
    ["ImagePullBackOff", "danger"],
    ["Error", "danger"],
    ["Evicted", "danger"],
    ["Init:Error", "danger"],
    ["ExitCode:3", "danger"],
  ])("%s is %s", (label, tone) => {
    expect(podStatus(pod({ phase: label, reason: label })).tone).toBe(tone);
  });
});

test("envText names references and never resolves them", () => {
  expect(envText({ name: "A", value: "1" })).toBe("A=1");
  expect(envText({ name: "A" })).toBe("A=");
  expect(
    envText({
      name: "A",
      valueFrom: { secretKeyRef: { name: "s", key: "k" } },
    }),
  ).toBe("A from secret s/k");
  expect(
    envText({
      name: "A",
      valueFrom: { configMapKeyRef: { name: "c", key: "k" } },
    }),
  ).toBe("A from configmap c/k");
  expect(
    envText({
      name: "A",
      valueFrom: { fieldRef: { fieldPath: "metadata.name" } },
    }),
  ).toBe("A from field metadata.name");
  expect(
    envText({
      name: "A",
      valueFrom: { resourceFieldRef: { resource: "limits.cpu" } },
    }),
  ).toBe("A from resource limits.cpu");
});

test("probeText reads like kubectl describe", () => {
  expect(
    probeText({
      httpGet: { path: "/h", port: 80 },
      initialDelaySeconds: 2,
      periodSeconds: 5,
      timeoutSeconds: 1,
      successThreshold: 1,
      failureThreshold: 3,
    }),
  ).toBe("http-get :80/h delay=2s timeout=1s period=5s #success=1 #failure=3");
  expect(probeText({ tcpSocket: { port: 80 } })).toBe(
    "tcp-socket :80 delay=0s timeout=1s period=10s #success=1 #failure=3",
  );
  expect(probeText({ exec: { command: ["a", "b"] } })).toMatch(
    /^exec \[a b\] /,
  );
  expect(probeText({ grpc: { port: 9 } })).toMatch(/^grpc :9 /);
});

test("containersOf joins spec and status for init and regular containers", () => {
  const rows = containersOf({
    metadata: { name: "p" },
    spec: {
      initContainers: [{ name: "i", image: "busybox" }],
      containers: [
        {
          name: "a",
          image: "web:1",
          ports: [{ containerPort: 80, protocol: "TCP", name: "http" }],
          env: [{ name: "A", value: "1" }],
          envFrom: [
            { secretRef: { name: "s" } },
            { configMapRef: { name: "c" }, prefix: "P_" },
          ],
          volumeMounts: [{ name: "v", mountPath: "/d", readOnly: true }],
          readinessProbe: { tcpSocket: { port: 80 } },
          resources: { requests: { cpu: "1" }, limits: { memory: "1Gi" } },
        },
      ],
    },
    status: {
      containerStatuses: [
        {
          name: "a",
          ready: true,
          restartCount: 2,
          state: { waiting: { reason: "Back" } },
        },
      ],
    },
  });
  expect(rows.map((r) => [r.name, r.init])).toEqual([
    ["i", true],
    ["a", false],
  ]);
  const a = rows[1];
  expect(a).toMatchObject({
    image: "web:1",
    state: "Waiting: Back",
    ready: true,
    restarts: 2,
  });
  expect(a.ports).toEqual(["http 80/TCP"]);
  expect(a.portSpecs).toEqual([
    { containerPort: 80, name: "http", protocol: "TCP" },
  ]);
  expect(a.env).toEqual([
    "A=1",
    "all of secret s",
    "all of configmap c (prefix P_)",
  ]);
  expect(a.mounts).toEqual(["/d from v (ro)"]);
  expect(a.probes[0]).toMatch(/^readiness: tcp-socket :80/);
  expect(a.requests).toEqual(["cpu 1"]);
  expect(a.limits).toEqual(["memory 1Gi"]);
  expect(rows[0].state).toBe("Not started");
});

test("container ports are data too, with null for what is not declared", () => {
  const rows = containersOf({
    metadata: { name: "p" },
    spec: {
      containers: [
        {
          name: "a",
          ports: [
            { containerPort: 9090 },
            { name: "dns", containerPort: 53, protocol: "UDP" },
          ],
        },
      ],
    },
  });
  expect(rows[0]?.ports).toEqual(["9090/TCP", "dns 53/UDP"]);
  expect(rows[0]?.portSpecs).toEqual([
    { containerPort: 9090, name: null, protocol: null },
    { containerPort: 53, name: "dns", protocol: "UDP" },
  ]);
});
