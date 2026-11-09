import type { PortForwardKind } from "../../ipc/generated/PortForwardKind";
import type { KubeObject } from "../../kinds/objects";

export interface PortChoice {
  port: number;
  name: string | null;
}

export type Check<T> =
  | { ok: true; value: T }
  | { ok: false; message: string | null };

export const LOCAL_PORT_RANGE =
  "A port from 1024 to 65535, or empty for a random free port";
export const LOCAL_PORT_PRIVILEGED =
  "Ports below 1024 need administrator rights on this machine; pick 1024 or above";
export const TARGET_PORT_RANGE = "A port from 1 to 65535";

/** Ports a forward opens in the browser by default (spec §5.3). */
export const BROWSER_PORTS: ReadonlySet<number> = new Set([
  80, 3000, 8080, 9090, 9200,
]);

// biome-ignore lint/suspicious/noExplicitAny: port lists are free-form JSON.
type Json = any;

function listOf(value: unknown): Json[] {
  return Array.isArray(value) ? value : [];
}

/** Kubernetes reads a port without a protocol as TCP. */
export function isTcp(protocol: string | null | undefined): boolean {
  return !protocol || protocol === "TCP";
}

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

/**
 * The TCP ports a forward can target: a Service's `spec.ports` by `port`, or the
 * `containerPort`s of a Pod's regular containers. Each number is offered once.
 */
export function portChoices(
  kind: PortForwardKind,
  object: KubeObject,
): PortChoice[] {
  const declared: { port: unknown; name: unknown; protocol: unknown }[] =
    kind === "service"
      ? listOf(object.spec?.ports).map((p) => ({
          port: p?.port,
          name: p?.name,
          protocol: p?.protocol,
        }))
      : listOf(object.spec?.containers).flatMap((c) =>
          listOf(c?.ports).map((p) => ({
            port: p?.containerPort,
            name: p?.name,
            protocol: p?.protocol,
          })),
        );
  const seen = new Set<number>();
  const choices: PortChoice[] = [];
  for (const p of declared) {
    const protocol = typeof p.protocol === "string" ? p.protocol : null;
    if (!isPort(p.port) || !isTcp(protocol) || seen.has(p.port)) continue;
    seen.add(p.port);
    choices.push({
      port: p.port,
      name: typeof p.name === "string" && p.name !== "" ? p.name : null,
    });
  }
  return choices;
}

/** "8080/TCP · http", or "8080/TCP" for a port without a name. */
export function choiceLabel(choice: PortChoice): string {
  return choice.name
    ? `${choice.port}/TCP · ${choice.name}`
    : `${choice.port}/TCP`;
}

/** Digits only, after trimming; anything else is not a port. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** The local port field: empty for a random port, else 1024 to 65535. */
export function checkLocalPort(text: string): Check<number | null> {
  if (text.trim() === "") return { ok: true, value: null };
  const n = wholeNumber(text);
  if (n !== null && n >= 1024 && n <= 65535) return { ok: true, value: n };
  if (n !== null && n >= 1 && n < 1024) {
    return { ok: false, message: LOCAL_PORT_PRIVILEGED };
  }
  return { ok: false, message: LOCAL_PORT_RANGE };
}

/** The typed target port when nothing is declared. Empty is not valid but says nothing yet. */
export function checkTargetPort(text: string): Check<number> {
  if (text.trim() === "") return { ok: false, message: null };
  const n = wholeNumber(text);
  if (n !== null && n >= 1 && n <= 65535) return { ok: true, value: n };
  return { ok: false, message: TARGET_PORT_RANGE };
}
