/**
 * The keyboard shortcuts of spec C §7.2 and D2 §13: one table that the Keyboard
 * shortcuts dialog shows and the key handlers match, so the two cannot drift apart.
 * The Charts keys act only while a chart has focus; the chart reads them itself.
 */

export type Platform = "macos" | "windows" | "linux";

export function platformOf(userAgent: string): Platform {
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macos";
  if (/Windows/.test(userAgent)) return "windows";
  return "linux";
}

export const PLATFORM: Platform = platformOf(navigator.userAgent);
/** Whether `Mod` is ⌘ (macOS) rather than Ctrl. */
export const IS_MAC = PLATFORM === "macos";

/** `Mod` is ⌘ on macOS and Ctrl elsewhere; `Ctrl` is the Control key everywhere. */
export type Modifier = "Mod" | "Ctrl" | "Alt" | "Shift";

/** Modifiers in reading order, then the key as the table writes it. */
export interface Chord {
  mods: Modifier[];
  key: string;
}

/** `or` joins alternatives (⌥← or ⌘[); `/` joins a pair (Up / Down). */
export interface KeySpec {
  chords: Chord[];
  join: "or" | "/";
}

export const SHORTCUT_GROUPS = [
  "General",
  "Navigation",
  "Command palette",
  "Dock and terminal",
  "Dialogs and lists",
  "Charts",
] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export type ShortcutId =
  | "palette"
  | "shortcuts"
  | "preferences"
  | "close"
  | "back"
  | "forward"
  | "mouse"
  | "terminal"
  | "palette-move"
  | "palette-run"
  | "dock-move"
  | "terminal-copy"
  | "terminal-paste"
  | "focus"
  | "press"
  | "chartSample"
  | "chartEnds"
  | "chartHide";

export interface ShortcutRow {
  id: ShortcutId;
  group: ShortcutGroup;
  action: string;
  keys: KeySpec;
  /** The keys on macOS when they differ from `keys`. */
  mac?: KeySpec;
}

const MODIFIERS: readonly string[] = ["Mod", "Ctrl", "Alt", "Shift"];

function isModifier(part: string): part is Modifier {
  return MODIFIERS.includes(part);
}

/** "Mod+Shift+P" → Mod, Shift and P. */
function parseChord(text: string): Chord {
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  return { mods: parts.filter(isModifier), key };
}

function one(text: string): KeySpec {
  return { chords: [parseChord(text)], join: "or" };
}

function either(...texts: string[]): KeySpec {
  return { chords: texts.map(parseChord), join: "or" };
}

function pair(first: string, second: string): KeySpec {
  return { chords: [parseChord(first), parseChord(second)], join: "/" };
}

export const SHORTCUTS: readonly ShortcutRow[] = [
  {
    id: "palette",
    group: "General",
    action: "Command palette",
    keys: one("Mod+Shift+P"),
  },
  {
    id: "shortcuts",
    group: "General",
    action: "Keyboard shortcuts",
    keys: one("Mod+/"),
  },
  {
    id: "preferences",
    group: "General",
    action: "Preferences",
    keys: one("Mod+,"),
  },
  {
    id: "close",
    group: "General",
    action: "Close the palette, dialog or menu",
    keys: one("Esc"),
  },
  {
    id: "back",
    group: "Navigation",
    action: "Back",
    keys: one("Alt+Left"),
    mac: either("Alt+Left", "Mod+["),
  },
  {
    id: "forward",
    group: "Navigation",
    action: "Forward",
    keys: one("Alt+Right"),
    mac: either("Alt+Right", "Mod+]"),
  },
  {
    id: "mouse",
    group: "Navigation",
    action: "Back and forward with the mouse",
    keys: pair("Mouse 4", "Mouse 5"),
  },
  {
    id: "terminal",
    group: "Navigation",
    action: "Terminal for this cluster",
    keys: one("Ctrl+`"),
  },
  {
    id: "palette-move",
    group: "Command palette",
    action: "Previous or next result",
    keys: pair("Up", "Down"),
  },
  {
    id: "palette-run",
    group: "Command palette",
    action: "Run the selected result",
    keys: one("Enter"),
  },
  {
    id: "dock-move",
    group: "Dock and terminal",
    action: "Move a dock tab",
    keys: pair("Ctrl+Shift+PageUp", "Ctrl+Shift+PageDown"),
  },
  {
    id: "terminal-copy",
    group: "Dock and terminal",
    action: "Copy in a terminal",
    keys: one("Ctrl+Shift+C"),
    mac: one("Mod+C"),
  },
  {
    id: "terminal-paste",
    group: "Dock and terminal",
    action: "Paste in a terminal",
    keys: one("Ctrl+Shift+V"),
    mac: one("Mod+V"),
  },
  {
    id: "focus",
    group: "Dialogs and lists",
    action: "Move between controls",
    keys: pair("Tab", "Shift+Tab"),
  },
  {
    id: "press",
    group: "Dialogs and lists",
    action: "Press the focused button",
    keys: pair("Enter", "Space"),
  },
  {
    id: "chartSample",
    group: "Charts",
    action: "Previous or next sample",
    keys: pair("Left", "Right"),
  },
  {
    id: "chartEnds",
    group: "Charts",
    action: "First or last sample",
    keys: pair("Home", "End"),
  },
  {
    id: "chartHide",
    group: "Charts",
    action: "Hide the readout",
    keys: one("Esc"),
  },
];

export function shortcut(id: ShortcutId): ShortcutRow {
  const row = SHORTCUTS.find((r) => r.id === id);
  if (!row) throw new Error(`no shortcut ${id}`);
  return row;
}

export function keysFor(id: ShortcutId, mac: boolean): KeySpec {
  const row = shortcut(id);
  return mac && row.mac ? row.mac : row.keys;
}

const MAC_MODIFIERS: Record<Modifier, string> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};
const WORD_MODIFIERS: Record<Modifier, string> = {
  Mod: "Ctrl",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
};
const MAC_KEYS: Partial<Record<string, string>> = {
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
};

/** ⌘⇧P on macOS (no separator), Ctrl+Shift+P elsewhere. */
export function formatChord(chord: Chord, mac: boolean): string {
  if (mac) {
    const mods = chord.mods.map((m) => MAC_MODIFIERS[m]).join("");
    return `${mods}${MAC_KEYS[chord.key] ?? chord.key}`;
  }
  return [...chord.mods.map((m) => WORD_MODIFIERS[m]), chord.key].join("+");
}

/** All the row's keys, as the Keyboard shortcuts dialog's filter reads them. */
export function keysText(id: ShortcutId, mac: boolean): string {
  const spec = keysFor(id, mac);
  const joiner = spec.join === "or" ? " or " : " / ";
  return spec.chords.map((c) => formatChord(c, mac)).join(joiner);
}

/** The first chord, for labels, the header's key chip and the palette's hints. */
export function shortKeys(id: ShortcutId, mac: boolean): string {
  return formatChord(keysFor(id, mac).chords[0], mac);
}

/** Key names of the table that differ from `KeyboardEvent.key`. */
const EVENT_KEYS: Partial<Record<string, string>> = {
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Esc: "Escape",
  Space: " ",
};

function keyMatches(key: string, event: KeyboardEvent): boolean {
  if (/^[A-Z]$/.test(key)) {
    // The physical key, so the shortcut works on any layout. A synthetic event
    // without a code (some drivers send one) falls back to the key's name.
    if (event.code === "" || event.code === "Unidentified") {
      return event.key.toUpperCase() === key;
    }
    return event.code === `Key${key}`;
  }
  if (key === "`") return event.code === "Backquote";
  return event.key === (EVENT_KEYS[key] ?? key);
}

/** Exact modifiers, except that Shift is ignored for `/` and `,` (spec C §4.3). */
export function matchesChord(
  chord: Chord,
  event: KeyboardEvent,
  mac: boolean,
): boolean {
  const has = (m: Modifier) => chord.mods.includes(m);
  const ctrl = has("Ctrl") || (has("Mod") && !mac);
  const meta = has("Mod") && mac;
  if (event.ctrlKey !== ctrl || event.metaKey !== meta) return false;
  if (event.altKey !== has("Alt")) return false;
  const shiftFree = chord.key === "/" || chord.key === ",";
  if (!shiftFree && event.shiftKey !== has("Shift")) return false;
  return keyMatches(chord.key, event);
}

export function matchesShortcut(
  id: ShortcutId,
  event: KeyboardEvent,
  mac: boolean,
): boolean {
  return keysFor(id, mac).chords.some((c) => matchesChord(c, event, mac));
}
