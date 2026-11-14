import { useCallback, useMemo, useRef, useState } from "react";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { type DrawerTarget, targetKey } from "../../kinds/detail/links";
import type { KubeObject } from "../../kinds/objects";
import {
  type DrawerEntry,
  type DrawerHistory,
  goBack,
  previousEntry,
  pushTarget,
  setTab as setEntryTab,
  shownEntry,
  startHistory,
} from "./drawerHistory";

export interface DrawerHistoryApi {
  /** The row the URL's `object` names, or null while the drawer is closed. */
  root: DrawerTarget | null;
  shown: DrawerEntry | null;
  /** The entry Back returns to, or null at the root. */
  previous: DrawerEntry | null;
  /** Counts open and back calls; a change moves focus into the drawer (spec H20). */
  step: number;
  open(target: DrawerTarget): void;
  back(): void;
  setTab(tab: string): void;
  /** Back to the root alone, as a row click does (spec H18). */
  reset(): void;
  /** The last live object seen for an entry still in the history. */
  lastSeen(target: DrawerTarget): KubeObject | null;
  remember(target: DrawerTarget, object: KubeObject): void;
}

/** The root target of the screen's resource for the URL's `object` key (`<ns>/<name>`). */
export function rootTarget(
  resource: Pick<ResourceRef, "group" | "plural">,
  openKey: string | null,
): DrawerTarget | null {
  if (openKey === null) return null;
  const slash = openKey.indexOf("/");
  return {
    group: resource.group,
    plural: resource.plural,
    namespace: slash > 0 ? openKey.slice(0, slash) : null,
    name: openKey.slice(slash + 1),
  };
}

/**
 * The drawer's back history, owned by the resource screen (spec H §9.3). It restarts at
 * the root whenever `openKey` changes; the screen is keyed by cluster and list, so the
 * history never outlives them. Opening a link changes no URL.
 */
export function useDrawerHistory(
  resource: ResourceRef,
  openKey: string | null,
): DrawerHistoryApi {
  const { group, plural } = resource;
  const root = useMemo(
    () => rootTarget({ group, plural }, openKey),
    [group, plural, openKey],
  );
  const [state, setState] = useState(() => ({
    owner: openKey,
    history: startHistory(root),
    step: 0,
  }));
  let history: DrawerHistory = state.history;
  // Another root starts a new history, with no render showing the old one.
  if (state.owner !== openKey) {
    history = startHistory(root);
    setState({ owner: openKey, history, step: state.step });
  }
  const seen = useRef(new Map<string, KubeObject>());

  const update = useCallback(
    (change: (h: DrawerHistory) => DrawerHistory, moves: boolean) =>
      setState((s) => ({
        ...s,
        history: change(s.history),
        step: moves ? s.step + 1 : s.step,
      })),
    [],
  );
  const open = useCallback(
    (target: DrawerTarget) => update((h) => pushTarget(h, target), true),
    [update],
  );
  const back = useCallback(() => update(goBack, true), [update]);
  const setTab = useCallback(
    (tab: string) => update((h) => setEntryTab(h, tab), false),
    [update],
  );
  const reset = useCallback(
    () =>
      setState((s) => ({
        owner: openKey,
        history: startHistory(root),
        step: s.step,
      })),
    [openKey, root],
  );
  const entries = history.entries;
  const lastSeen = useCallback(
    (target: DrawerTarget) => seen.current.get(targetKey(target)) ?? null,
    [],
  );
  const remember = useCallback(
    (target: DrawerTarget, object: KubeObject) => {
      const keep = new Set(entries.map((e) => targetKey(e.target)));
      for (const key of seen.current.keys()) {
        if (!keep.has(key)) seen.current.delete(key);
      }
      seen.current.set(targetKey(target), object);
    },
    [entries],
  );

  return {
    root,
    shown: shownEntry(history),
    previous: previousEntry(history),
    step: state.step,
    open,
    back,
    setTab,
    reset,
    lastSeen,
    remember,
  };
}
