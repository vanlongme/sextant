import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../objects";

/** The Argo CD API group and version (spec G §4). */
export const ARGO_GROUP = "argoproj.io";
export const ARGO_API_VERSION = "argoproj.io/v1alpha1";

/** What a cell or a fact shows when the object has nothing for it. */
export const NONE = "—";

function argoRef(plural: string, kind: string): ResourceRef {
  return {
    group: ARGO_GROUP,
    version: "v1alpha1",
    plural,
    kind,
    namespaced: true,
  };
}

export const APPLICATIONS = argoRef("applications", "Application");
export const APPLICATION_SETS = argoRef("applicationsets", "ApplicationSet");
export const APP_PROJECTS = argoRef("appprojects", "AppProject");

/** An object as the readers take it: only `metadata` is sure to be there. */
export type Obj = Pick<KubeObject, "metadata"> & Partial<KubeObject>;

// biome-ignore lint/suspicious/noExplicitAny: Argo CD objects vary in shape.
export function list<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A non-empty string, or undefined for anything else. */
export function text(value: unknown): string | undefined {
  return isText(value) ? value : undefined;
}

/** The first value, then " +N" for the others, or NONE when there are none. */
export function firstAndMore(values: string[]): string {
  if (values.length === 0) return NONE;
  return values.length === 1 ? values[0] : `${values[0]} +${values.length - 1}`;
}

/** `<namespace>/<name>`, as toasts name an object. */
export function nsName(o: Obj): string {
  return `${o.metadata.namespace ?? ""}/${o.metadata.name}`;
}
