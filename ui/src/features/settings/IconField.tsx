import { ImageUp, X } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { Button } from "../../design";
import styles from "./ClusterSettingsScreen.module.css";
import { checkIconFile, ICON_ERROR } from "./settingsForm";

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The cluster's icon: a preview, Choose image and Remove. A PNG or SVG of at most
 * 256 KB is read as a data URL and shown only through `<img>`, so an SVG's scripts
 * never run.
 */
export function IconField(props: {
  icon: string | null;
  onChange(icon: string | null): void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Cleared, so choosing the same file again is a change too.
    input.value = "";
    if (!file) return;
    const problem = checkIconFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      const url = await readDataUrl(file);
      setError(null);
      props.onChange(url);
    } catch {
      setError(ICON_ERROR);
    }
  }

  return (
    <div className={styles.icon}>
      <span className={styles.iconLabel}>Icon</span>
      {props.icon ? (
        <img
          src={props.icon}
          alt=""
          className={styles.iconImage}
          data-testid="settings-icon-preview"
        />
      ) : (
        <span className={styles.noIcon} data-testid="settings-icon-preview">
          No icon
        </span>
      )}
      <Button
        size="sm"
        onClick={() => fileRef.current?.click()}
        data-testid="settings-icon-choose"
      >
        <ImageUp size={14} aria-hidden="true" />
        Choose image
      </Button>
      {props.icon ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setError(null);
            props.onChange(null);
          }}
          data-testid="settings-icon-remove"
        >
          <X size={14} aria-hidden="true" />
          Remove
        </Button>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/svg+xml"
        hidden
        onChange={(e) => void pick(e)}
        data-testid="settings-icon-file"
      />
      {error ? (
        <span
          role="alert"
          className={styles.iconError}
          data-testid="settings-icon-error"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
