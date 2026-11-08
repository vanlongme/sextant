import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./IconButton.module.css";
import { Tooltip } from "./Tooltip";

export type IconButtonProps = {
  label: string;
  icon: ReactNode;
  /**
   * False swaps the tooltip for the native `title`. Menu triggers use it: closing a
   * menu hands focus back to its trigger, and a tooltip opened by that focus would
   * cover what is under it.
   */
  tooltip?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function IconButton({
  label,
  icon,
  className,
  type = "button",
  tooltip = true,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={tooltip ? rest.title : label}
      className={[styles.button, className].filter(Boolean).join(" ")}
    >
      {icon}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
