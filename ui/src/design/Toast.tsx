import * as RT from "@radix-ui/react-toast";
import { useSyncExternalStore } from "react";
import styles from "./Toast.module.css";

type Kind = "success" | "error" | "info";
interface Item {
  id: number;
  kind: Kind;
  message: string;
  details?: string;
}

let items: Item[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function push(kind: Kind, message: string, details?: string): void {
  items = [...items, { id: nextId++, kind, message, details }];
  emit();
}
function dismiss(id: number): void {
  items = items.filter((i) => i.id !== id);
  emit();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const toast = {
  success: (m: string) => push("success", m),
  error: (m: string, details?: string) => push("error", m, details),
  info: (m: string) => push("info", m),
};

export function Toaster() {
  const current = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
  return (
    <RT.Provider swipeDirection="right">
      {current.map((t) => (
        <RT.Root
          key={t.id}
          className={`${styles.toast} ${styles[t.kind]}`}
          duration={t.kind === "error" ? 10000 : 4000}
          onOpenChange={(o) => {
            if (!o) dismiss(t.id);
          }}
        >
          <RT.Title className={styles.title}>{t.message}</RT.Title>
          {t.details ? (
            <RT.Description className={styles.details}>
              {t.details}
            </RT.Description>
          ) : null}
          <RT.Close className={styles.close} aria-label="Dismiss">
            ×
          </RT.Close>
        </RT.Root>
      ))}
      <RT.Viewport className={styles.viewport} />
    </RT.Provider>
  );
}
