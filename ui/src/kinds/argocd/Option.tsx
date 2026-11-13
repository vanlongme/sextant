import styles from "./argocd.module.css";

/** A checkbox with a line that explains it, as in the Argo CD dialogs. */
export function Option(props: {
  label: string;
  help: string;
  checked: boolean;
  onChange(value: boolean): void;
  testId: string;
}) {
  return (
    <label className={styles.option}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        data-testid={props.testId}
      />
      <span>
        {props.label}
        <span className={styles.help}> {props.help}</span>
      </span>
    </label>
  );
}
