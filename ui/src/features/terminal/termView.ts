import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { PALETTE, type TerminalColors } from "../../design/palette";
import type { TerminalSize } from "../../ipc/generated/TerminalSize";
import { handleTerminalKey, IS_MAC } from "./terminalKeys";
import { type NoteTone, noteLine } from "./terminalText";
import "./termView.css";

export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_SCROLLBACK = 5000;

/** `--font-mono` as tinyorbit.css declares it, for when the variable cannot be read. */
const MONO_FALLBACK =
  '"JetBrains Mono", ui-monospace, "SFMono-Regular", "Menlo", monospace';

/** One terminal screen. Unit tests use a fake; only the e2e suite runs xterm. */
export interface TermView {
  /** Created once, and moved between panels by the session registry. */
  readonly host: HTMLDivElement;
  /** Writes process output; `done` runs once xterm has taken it in. */
  write(data: Uint8Array, done: () => void): void;
  /** Writes `text` as plain text on its own line: dim for a note, red for an error. */
  writeNote(text: string, tone: NoteTone): void;
  onInput(listener: (data: string) => void): void;
  setInputEnabled(enabled: boolean): void;
  /** Fits the screen to the host. Null while the host has no size. */
  fit(): TerminalSize | null;
  reset(): void;
  focus(): void;
  setTheme(theme: "light" | "dark"): void;
  dispose(): void;
}

export type TermViewFactory = () => TermView;

export function xtermTheme(colors: TerminalColors): ITheme {
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor,
    cursorAccent: colors.background,
    selectionBackground: colors.selection,
    ...colors.ansi,
  };
}

function monoFont(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return value === "" ? MONO_FALLBACK : value;
}

class XtermView implements TermView {
  readonly host = document.createElement("div");
  private readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private opened = false;
  private inputOn = false;
  /** Whether the cursor is at the start of a line, so a note needs no line break first. */
  private atLineStart = true;
  private listener: ((data: string) => void) | null = null;

  constructor() {
    this.host.dataset.terminalHost = "";
    this.term = new Terminal({
      fontFamily: monoFont(),
      fontSize: TERMINAL_FONT_SIZE,
      scrollback: TERMINAL_SCROLLBACK,
      disableStdin: true,
      theme: xtermTheme(PALETTE.dark.terminal),
    });
    this.term.loadAddon(this.fitAddon);
    this.term.attachCustomKeyEventHandler((event) =>
      handleTerminalKey(
        event,
        {
          hasSelection: () => this.term.hasSelection(),
          getSelection: () => this.term.getSelection(),
          paste: (text) => this.term.paste(text),
          inputEnabled: () => this.inputOn,
        },
        IS_MAC,
      ),
    );
    this.term.onData((data) => this.listener?.(data));
  }

  write(data: Uint8Array, done: () => void): void {
    if (data.length > 0) this.atLineStart = data[data.length - 1] === 0x0a;
    this.term.write(data, done);
  }

  writeNote(text: string, tone: NoteTone): void {
    this.term.write(`${this.atLineStart ? "" : "\r\n"}${noteLine(text, tone)}`);
    this.atLineStart = true;
  }

  onInput(listener: (data: string) => void): void {
    this.listener = listener;
  }

  setInputEnabled(enabled: boolean): void {
    this.inputOn = enabled;
    this.term.options.disableStdin = !enabled;
  }

  fit(): TerminalSize | null {
    if (
      !this.host.isConnected ||
      this.host.clientWidth === 0 ||
      this.host.clientHeight === 0
    ) {
      return null;
    }
    // xterm measures its cells when it opens, so it opens into a host that has a size.
    if (!this.opened) {
      this.term.open(this.host);
      this.opened = true;
    }
    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed || !(proposed.cols >= 1) || !(proposed.rows >= 1))
      return null;
    const cols = Math.floor(proposed.cols);
    const rows = Math.floor(proposed.rows);
    if (cols !== this.term.cols || rows !== this.term.rows) {
      this.term.resize(cols, rows);
    }
    // The host may just have come back into the document: draw it again.
    this.term.refresh(0, this.term.rows - 1);
    return { cols, rows };
  }

  reset(): void {
    this.term.reset();
    this.atLineStart = true;
  }

  focus(): void {
    if (this.opened) this.term.focus();
  }

  setTheme(theme: "light" | "dark"): void {
    this.term.options.theme = xtermTheme(PALETTE[theme].terminal);
  }

  dispose(): void {
    this.term.dispose();
    this.host.remove();
  }
}

let factory: TermViewFactory = () => new XtermView();

export function createTermView(): TermView {
  return factory();
}

/** Swaps the factory, for tests. Null puts the xterm view back. */
export function setTermViewFactory(next: TermViewFactory | null): void {
  factory = next ?? (() => new XtermView());
}
