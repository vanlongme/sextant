import { expect, test } from "vitest";
import { parse } from "yaml";
import { TEMPLATES } from "./templates";
import { validateYaml } from "./validate";

test("there is a template for each common kind", () => {
  expect(TEMPLATES.map((t) => t.label)).toEqual([
    "Pod",
    "Deployment",
    "Service",
    "ConfigMap",
    "Secret",
    "Job",
    "CronJob",
    "Ingress",
    "PersistentVolumeClaim",
    "Namespace",
  ]);
  expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
});

test.each(TEMPLATES)("the $label template is one valid object", (template) => {
  expect(validateYaml(template.yaml)).toEqual({ ok: true, documents: 1 });
  const object = parse(template.yaml);
  expect(object.kind).toBe(template.label);
  expect(object.apiVersion).toBeTruthy();
  expect(object.metadata.name).toBeTruthy();
  // The namespace comes from the filter, or `default`, when the tab applies it.
  expect(object.metadata.namespace).toBeUndefined();
});
