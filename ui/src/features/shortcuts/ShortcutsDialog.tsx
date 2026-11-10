import { Search, X } from "lucide-react";
import { Fragment, useState } from "react";
import { ShellDialog } from "../../app/ShellDialog";
import {
  formatChord,
  keysFor,
  keysText,
  PLATFORM,
  type Platform,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  type ShortcutRow,
} from "../../app/shortcuts";
import { IconButton, Input } from "../../design";
import { useShell } from "../../stores/shell";
import styles from "./ShortcutsDialog.module.css";

const PLATFORM_NAMES: Record<Platform, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** The note under the table (spec C §7.1). */
export function footerNote(platform: Platform): string {
  if (platform === "macos") return "Shown for macOS.";
  return `Shown for ${PLATFORM_NAMES[platform]}. On macOS, Ctrl in most shortcuts is ⌘ and Alt is ⌥.`;
}

/** Whether the action, the group title or the formatted keys contain `needle`. */
function matches(row: ShortcutRow, needle: string, mac: boolean): boolean {
  return [row.action, row.group, keysText(row.id, mac)].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

export function ShortcutsDialog() {
  const open = useShell((s) => s.dialog === "shortcuts");
  const close = useShell((s) => s.close);
  return (
    <ShellDialog
      open={open}
      onClose={() => close("shortcuts")}
      label="Keyboard shortcuts"
      testId="shortcuts-dialog"
      kind="panel"
    >
      <ShortcutsBody platform={PLATFORM} onClose={() => close("shortcuts")} />
    </ShellDialog>
  );
}

/** The dialog's content; `platform` is a prop so tests can show each one. */
export function ShortcutsBody(props: { platform: Platform; onClose(): void }) {
  const mac = props.platform === "macos";
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const groups = SHORTCUT_GROUPS.map((group) => ({
    group,
    rows: SHORTCUTS.filter(
      (row) => row.group === group && matches(row, needle, mac),
    ),
  })).filter((g) => g.rows.length > 0);

  return (
    <>
      <div className={styles.header}>
        <h2 className={styles.title}>Keyboard shortcuts</h2>
        <IconButton
          label="Close"
          icon={<X size={16} aria-hidden="true" />}
          tooltip={false}
          onClick={props.onClose}
        />
      </div>
      <div className={styles.filter}>
        <Search size={16} aria-hidden="true" className={styles.searchIcon} />
        <Input
          aria-label="Filter"
          placeholder="An action or a key"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className={styles.filterInput}
          autoComplete="off"
          spellCheck={false}
          data-autofocus=""
          data-testid="shortcuts-filter"
        />
      </div>
      <div className={styles.list}>
        {groups.length === 0 ? (
          <p className={styles.empty} data-testid="shortcuts-empty">
            {`No shortcut matches "${filter.trim()}".`}
          </p>
        ) : (
          groups.map(({ group, rows }) => (
            <section key={group} className={styles.group}>
              <h3 className={styles.groupTitle}>{group}</h3>
              {rows.map((row) => (
                <div
                  key={row.id}
                  className={styles.row}
                  data-testid={`shortcut-${row.id}`}
                >
                  <span className={styles.action}>{row.action}</span>
                  <Keys row={row} mac={mac} />
                </div>
              ))}
            </section>
          ))
        )}
      </div>
      <p className={styles.note}>{footerNote(props.platform)}</p>
    </>
  );
}

/** Key chips; `or` between alternatives, `/` between the two keys of a pair. */
function Keys({ row, mac }: { row: ShortcutRow; mac: boolean }) {
  const spec = keysFor(row.id, mac);
  return (
    <span className={styles.keys}>
      {spec.chords.map((chord, i) => {
        const text = formatChord(chord, mac);
        return (
          <Fragment key={text}>
            {i > 0 ? <span className={styles.joiner}>{spec.join}</span> : null}
            <kbd className={styles.chip}>{text}</kbd>
          </Fragment>
        );
      })}
    </span>
  );
}
