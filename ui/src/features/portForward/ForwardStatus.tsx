import { StatusDot } from "../../design";
import type { PortForward } from "../../ipc/generated/PortForward";
import { STATE_LOOK } from "./forwardText";
import styles from "./PortForward.module.css";

/** A dot and the state's label, as the catalog shows a cluster's state. */
export function ForwardStatus(props: { forward: PortForward; testId: string }) {
  const look = STATE_LOOK[props.forward.state];
  return (
    <span className={styles.status} data-testid={props.testId}>
      <StatusDot tone={look.tone} label={look.label} />
      <span aria-hidden="true">{look.label}</span>
    </span>
  );
}
