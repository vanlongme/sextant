import { isScalar, LineCounter, parseAllDocuments, parseDocument } from "yaml";

export type YamlCheck =
  | { ok: true; documents: number }
  | { ok: false; line: number; column: number; message: string };

/** A document with nothing in it, or only `null`, which is no object to send. */
function isEmpty(contents: unknown): boolean {
  return contents === null || (isScalar(contents) && contents.value === null);
}

/**
 * Checks YAML syntax before anything is sent. `documents` counts the ones that
 * are not empty, as the backend does. The message has no excerpt of the text:
 * it is the parser's own, with pretty printing off, because errors never quote
 * object contents.
 */
export function validateYaml(text: string): YamlCheck {
  const lineCounter = new LineCounter();
  const parsed = parseAllDocuments(text, {
    lineCounter,
    merge: true,
    prettyErrors: false,
  });
  // A stream with no documents has only the stream's own errors.
  const errors =
    "empty" in parsed ? parsed.errors : parsed.flatMap((d) => d.errors);
  const first = errors[0];
  if (first) {
    const { line, col } = lineCounter.linePos(first.pos[0]);
    return { ok: false, line, column: col, message: first.message };
  }
  return {
    ok: true,
    documents: parsed.filter((d) => !isEmpty(d.contents)).length,
  };
}

/** The sentence an editor shows for text that fails `validateYaml`. */
export function yamlProblem(check: Extract<YamlCheck, { ok: false }>): string {
  return `Line ${check.line}, column ${check.column}: ${check.message}`;
}

const SERVER_METADATA = [
  "creationTimestamp",
  "deletionGracePeriodSeconds",
  "deletionTimestamp",
  "generation",
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid",
];

/**
 * An edited object as text to create it from: without the fields that belong to
 * the object that is gone, which the server would refuse or take as a
 * precondition. Text that does not parse is returned as it is.
 */
export function stripServerFields(text: string): string {
  const document = parseDocument(text, { merge: true });
  if (document.errors.length > 0) return text;
  document.delete("status");
  for (const field of SERVER_METADATA) {
    document.deleteIn(["metadata", field]);
  }
  return document.toString();
}
