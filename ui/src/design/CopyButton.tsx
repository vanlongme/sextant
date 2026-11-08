import { Check, CircleAlert, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./CopyButton.module.css";
import { copyText } from "./clipboard";

type Outcome = "done" | "failed";
const SHOWN_MS: Record<Outcome, number> = { done: 1400, failed: 4000 };

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Copies `value()` when pressed, then says how it went: "Copied" for 1.4 s, or
 * "Clipboard blocked" for 4 s. `what` names the value, as in "Copy UID".
 */
export function CopyButton(props: {
  value: () => string;
  what: string;
  className?: string;
  testId?: string;
}) {
  const { value, what } = props;
  const [state, setState] = useState<"idle" | Outcome>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function show(outcome: Outcome) {
    clearTimeout(timer.current);
    setState(outcome);
    timer.current = setTimeout(() => setState("idle"), SHOWN_MS[outcome]);
  }

  async function copy() {
    try {
      await copyText(value());
      show("done");
    } catch {
      show("failed");
    }
  }

  const label = state === "done" ? `Copied ${what}` : `Copy ${what}`;
  const Icon =
    state === "done" ? Check : state === "failed" ? CircleAlert : Copy;
  return (
    <span className={styles.host}>
      {state === "idle" ? null : (
        <span className={styles.pill} aria-hidden="true">
          {state === "done" ? "Copied" : "Clipboard blocked"}
        </span>
      )}
      <button
        type="button"
        className={[styles.button, props.className].filter(Boolean).join(" ")}
        data-state={state}
        aria-label={label}
        title={
          state === "failed"
            ? `Could not copy ${what}; select the text instead`
            : label
        }
        onClick={() => void copy()}
        data-testid={props.testId ?? `copy-${kebab(what)}`}
      >
        <Icon size={14} aria-hidden="true" />
      </button>
      <span className={styles.status} role="status">
        {state === "done"
          ? "Copied to the clipboard"
          : state === "failed"
            ? `Could not copy ${what}`
            : ""}
      </span>
    </span>
  );
}
