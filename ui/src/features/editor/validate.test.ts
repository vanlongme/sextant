import { expect, test } from "vitest";
import { stripServerFields, validateYaml } from "./validate";

test("a valid single document", () => {
  expect(validateYaml("kind: Pod\nmetadata:\n  name: web\n")).toEqual({
    ok: true,
    documents: 1,
  });
});

test("valid multiple documents", () => {
  expect(validateYaml("a: 1\n---\nb: 2\n---\nc: 3\n")).toEqual({
    ok: true,
    documents: 3,
  });
});

test("comments alone and empty documents are valid and not counted", () => {
  expect(validateYaml("# nothing here\n")).toEqual({ ok: true, documents: 0 });
  expect(validateYaml("")).toEqual({ ok: true, documents: 0 });
  expect(validateYaml("---\n# only a comment\n---\na: 1\n---\n")).toEqual({
    ok: true,
    documents: 1,
  });
});

test("merge keys are valid, as they are for the backend", () => {
  expect(
    validateYaml("base: &b\n  a: 1\nfirst:\n  <<: *b\n  <<: *b\n"),
  ).toEqual({ ok: true, documents: 1 });
});

test("a syntax error gives line and column", () => {
  expect(validateYaml("a: 1\nb: [1, 2\n")).toMatchObject({
    ok: false,
    line: 3,
  });

  const result = validateYaml("a: 1\nb: 2\n  c: 3\n");
  expect(result).toMatchObject({ ok: false, line: 2, column: 4 });
  if (result.ok) throw new Error("expected an error");
  expect(result.message).not.toBe("");
});

test("a syntax error in a later document points into that document", () => {
  expect(validateYaml("a: 1\n---\nb: 2\n  c: 3\n")).toMatchObject({
    ok: false,
    line: 3,
  });
});

test("the error text does not quote the document", () => {
  const result = validateYaml("token: s3cret\n  other: s3cret-too\n");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).not.toContain("s3cret");
  expect(result.message).not.toContain("\n");
});

test("a tab-indented document is an error", () => {
  expect(validateYaml("a:\n\tb: 1\n")).toMatchObject({
    ok: false,
    line: 2,
    column: 1,
  });
});

test("stripServerFields drops what the server owns and keeps the rest", () => {
  const yaml = [
    "# keep me",
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    "  name: app",
    "  namespace: team-a",
    "  labels:",
    "    uid: stays",
    "  resourceVersion: '7'",
    "  uid: abc",
    "  creationTimestamp: '2026-01-01T00:00:00Z'",
    "  generation: 2",
    "data:",
    "  a: b",
    "status:",
    "  phase: Active",
    "",
  ].join("\n");

  expect(stripServerFields(yaml)).toBe(
    [
      "# keep me",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: app",
      "  namespace: team-a",
      "  labels:",
      "    uid: stays",
      "data:",
      "  a: b",
      "",
    ].join("\n"),
  );
});

test("stripServerFields leaves text it cannot parse as it is", () => {
  const broken = "a: 1\nb: [1, 2\n";
  expect(stripServerFields(broken)).toBe(broken);
});
