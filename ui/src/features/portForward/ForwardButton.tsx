import { ArrowRightLeft } from "lucide-react";
import { Button } from "../../design";

/** The per-port button of the Service and Pod details (spec §5.2). */
export function ForwardButton(props: {
  port: number;
  testId: string;
  onClick(): void;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`Forward port ${props.port}`}
      data-testid={props.testId}
      onClick={props.onClick}
    >
      <ArrowRightLeft size={14} aria-hidden="true" />
      Forward
    </Button>
  );
}
