import { useEffect, useRef, useState } from "react";
import type { IpcFailure } from "../../ipc/client";
import { asFailure } from "../../stores/helm";

export interface Fetched<T> {
  value: T | undefined;
  error: IpcFailure | null;
  loading: boolean;
  retry(): void;
}

/**
 * Reads `load()` once per `key`, and again on `retry`. A null key reads nothing, so a
 * tab can wait until it is first shown. An answer for an older key is dropped.
 */
export function useFetch<T>(
  key: string | null,
  load: () => Promise<T>,
): Fetched<T> {
  const [state, setState] = useState<{
    key: string;
    value: T | undefined;
    error: IpcFailure | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read on Retry.
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState({ key, value: undefined, error: null });
    latest.current().then(
      (value) => {
        if (live) setState({ key, value, error: null });
      },
      (error: unknown) => {
        if (live) setState({ key, value: undefined, error: asFailure(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const current = state !== null && state.key === key ? state : null;
  return {
    value: current?.value,
    error: current?.error ?? null,
    loading:
      key !== null && current?.value === undefined && current?.error == null,
    retry: () => setAttempt((n) => n + 1),
  };
}
