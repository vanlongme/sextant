import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../ipc/api";
import type { JsonValue } from "../ipc/generated/serde_json/JsonValue";

const SAVE_DELAY_MS = 300;

/**
 * A value kept between runs. It shows `initial` until the saved one arrives, unless
 * it was changed by then. Writes are saved after 300 ms without another change,
 * and a pending write is saved when the component goes away. The third value is
 * true once the saved value was read, or found missing or unreadable.
 */
export function useUiState<T>(
  key: string,
  initial: T,
): [T, (v: T) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  // The key whose saved value was read (or found missing), so `loaded` resets with the key.
  const [readKey, setReadKey] = useState<string | null>(null);
  const changed = useRef(false);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) {
      void api.uiStateSet(key, next.value as JsonValue).catch(() => {});
    }
  }, [key]);

  useEffect(() => {
    changed.current = false;
    let current = true;
    api
      .uiStateGet(key)
      .then((saved) => {
        if (current && !changed.current && saved !== null) {
          setValue(saved as T);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (current) setReadKey(key);
      });
    return () => {
      current = false;
      flush();
    };
  }, [key, flush]);

  const set = useCallback(
    (next: T) => {
      changed.current = true;
      setValue(next);
      pending.current = { value: next };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  return [value, set, readKey === key];
}
