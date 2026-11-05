import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./IconButton.module.css";
import { Tooltip } from "./Tooltip";

export type IconButtonProps = {
  label: string;
  icon: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function IconButton({
  label,
  icon,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        {...rest}
        type={type}
        aria-label={label}
        className={[styles.button, className].filter(Boolean).join(" ")}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
