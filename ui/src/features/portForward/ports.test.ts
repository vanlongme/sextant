import { expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import {
  BROWSER_PORTS,
  checkLocalPort,
  checkTargetPort,
  choiceLabel,
  isTcp,
  LOCAL_PORT_PRIVILEGED,
  LOCAL_PORT_RANGE,
  portChoices,
  TARGET_PORT_RANGE,
} from "./ports";

const SERVICE: KubeObject = {
  metadata: { name: "web", namespace: "shop" },
  spec: {
    ports: [
      { name: "http", port: 80, protocol: "TCP" },
      { name: "dns", port: 53, protocol: "UDP" },
      { port: 8443 },
      { name: "again", port: 80, protocol: "TCP" },
      { name: "broken", port: "eighty" },
    ],
  },
};

const POD: KubeObject = {
  metadata: { name: "web-1", namespace: "shop" },
  spec: {
    initContainers: [{ name: "setup", ports: [{ containerPort: 9999 }] }],
    containers: [
      {
        name: "app",
        ports: [
          { name: "http", containerPort: 8080, protocol: "TCP" },
          { containerPort: 9090 },
        ],
      },
      {
        name: "side",
        ports: [
          { name: "metrics", containerPort: 9090 },
          { name: "syslog", containerPort: 514, protocol: "UDP" },
          { name: "sctp", containerPort: 3868, protocol: "SCTP" },
        ],
      },
    ],
    ephemeralContainers: [{ name: "debug", ports: [{ containerPort: 7000 }] }],
  },
};

test("a port with no protocol counts as TCP", () => {
  expect(isTcp(undefined)).toBe(true);
  expect(isTcp(null)).toBe(true);
  expect(isTcp("")).toBe(true);
  expect(isTcp("TCP")).toBe(true);
  expect(isTcp("UDP")).toBe(false);
  expect(isTcp("SCTP")).toBe(false);
});

test("a Service offers each TCP port number once, with its name", () => {
  expect(portChoices("service", SERVICE)).toEqual([
    { port: 80, name: "http" },
    { port: 8443, name: null },
  ]);
});

test("a Pod offers the TCP ports of its regular containers, each number once", () => {
  expect(portChoices("pod", POD)).toEqual([
    { port: 8080, name: "http" },
    { port: 9090, name: null },
  ]);
});

test("an object without ports offers nothing", () => {
  expect(portChoices("service", { metadata: { name: "x" } })).toEqual([]);
  expect(
    portChoices("pod", { metadata: { name: "x" }, spec: { containers: "?" } }),
  ).toEqual([]);
});

test("a choice reads number/TCP, then the name after a middle dot", () => {
  expect(choiceLabel({ port: 8080, name: "http" })).toBe("8080/TCP · http");
  expect(choiceLabel({ port: 8443, name: null })).toBe("8443/TCP");
});

test("the ports that open the browser by default", () => {
  expect([...BROWSER_PORTS].sort((a, b) => a - b)).toEqual([
    80, 3000, 8080, 9090, 9200,
  ]);
});

test.each<[string, number | null]>([
  ["", null],
  ["   ", null],
  ["1024", 1024],
  [" 8080 ", 8080],
  ["08080", 8080],
  ["65535", 65535],
])("the local port %j is %j", (text, value) => {
  expect(checkLocalPort(text)).toEqual({ ok: true, value });
});

test.each(["1", "80", "1023", "0080"])(
  "the local port %j needs administrator rights",
  (text) => {
    expect(checkLocalPort(text)).toEqual({
      ok: false,
      message: LOCAL_PORT_PRIVILEGED,
    });
  },
);

test.each(["0", "65536", "1e3", "-1", "80.5", "abc", "99999999999999999999"])(
  "the local port %j is out of range",
  (text) => {
    expect(checkLocalPort(text)).toEqual({
      ok: false,
      message: LOCAL_PORT_RANGE,
    });
  },
);

test("the target port takes 1 to 65535, and an empty field says nothing yet", () => {
  expect(checkTargetPort("")).toEqual({ ok: false, message: null });
  expect(checkTargetPort(" 53 ")).toEqual({ ok: true, value: 53 });
  expect(checkTargetPort("1")).toEqual({ ok: true, value: 1 });
  expect(checkTargetPort("65535")).toEqual({ ok: true, value: 65535 });
  for (const text of ["0", "65536", "1e3", "http", "-5"]) {
    expect(checkTargetPort(text)).toEqual({
      ok: false,
      message: TARGET_PORT_RANGE,
    });
  }
});

test("the messages read as the spec says", () => {
  expect(LOCAL_PORT_RANGE).toBe(
    "A port from 1024 to 65535, or empty for a random free port",
  );
  expect(LOCAL_PORT_PRIVILEGED).toBe(
    "Ports below 1024 need administrator rights on this machine; pick 1024 or above",
  );
  expect(TARGET_PORT_RANGE).toBe("A port from 1 to 65535");
});
