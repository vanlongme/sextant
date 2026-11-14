import { ChevronDown, Search } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./Button";
import styles from "./FilterPopover.module.css";

export interface FilterPopoverProps {
  /** The trigger's text and title. */
  label: string;
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The dialog's accessible name. */
  name: string;
  /** The panel's width in px. */
  width: number;
  triggerTestId: string;
  testId: string;
  /** The search box, which takes focus on open. */
  search: {
    label: string;
    value: string;
    onChange(value: string): void;
    testId: string;
  };
  /** Select all, Clear and the tally. */
  tools: ReactNode;
  foot: ReactNode;
  /** The list; it scrolls. */
  children: ReactNode;
}

/** The anchor's first child is the trigger. */
function triggerOf(anchor: HTMLElement | null): HTMLElement | null {
  const first = anchor?.firstElementChild;
  return first instanceof HTMLElement ? first : null;
}

/**
 * A non-modal popover under its trigger, for a searchable checkbox list (spec H59).
 * Opening focuses the search; Escape closes and refocuses the trigger; a pointer down
 * outside closes it. The parent keeps `open`, so it can allow one popover at a time.
 */
export function FilterPopover(props: FilterPopoverProps): ReactElement {
  const { open } = props;
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const change = useRef(props.onOpenChange);
  change.current = props.onOpenChange;

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const bottom =
        triggerOf(anchor.current)?.getBoundingClientRect().bottom ?? 0;
      setMaxHeight(Math.max(0, window.innerHeight - bottom - 16));
    };
    measure();
    panel.current?.querySelector("input")?.focus();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && anchor.current?.contains(e.target))
        return;
      change.current(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      change.current(false);
      triggerOf(anchor.current)?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    el?.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      el?.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={anchor} className={styles.anchor}>
      <Button
        size="sm"
        variant="secondary"
        title={props.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={props.triggerTestId}
        onClick={() => props.onOpenChange(!open)}
      >
        <span className={styles.triggerLabel}>{props.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      {open ? (
        <div
          ref={panel}
          role="dialog"
          aria-label={props.name}
          data-testid={props.testId}
          className={styles.panel}
          style={{ width: props.width, maxHeight }}
        >
          <div className={styles.searchRow}>
            <Search
              size={14}
              aria-hidden="true"
              className={styles.searchIcon}
            />
            <input
              type="text"
              className={styles.search}
              placeholder={props.search.label}
              aria-label={props.search.label}
              data-testid={props.search.testId}
              value={props.search.value}
              onChange={(e) => props.search.onChange(e.target.value)}
            />
          </div>
          <div className={styles.tools}>{props.tools}</div>
          <div className={styles.list}>{props.children}</div>
          <p className={styles.foot}>{props.foot}</p>
        </div>
      ) : null}
    </div>
  );
}
