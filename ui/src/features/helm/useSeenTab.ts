import { useState } from "react";

/**
 * The open tab, and the tabs shown so far: a tab loads when first shown and keeps
 * what it loaded when another tab is chosen.
 */
export function useSeenTab<T extends string>(
  first: T,
): [T, (tab: T) => void, (tab: T) => boolean] {
  const [tab, setTab] = useState<T>(first);
  const [seen, setSeen] = useState<ReadonlySet<T>>(() => new Set([first]));
  const choose = (next: T) => {
    setTab(next);
    setSeen((s) => (s.has(next) ? s : new Set([...s, next])));
  };
  return [tab, choose, (t) => seen.has(t)];
}
