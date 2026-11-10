import { CopyButton } from "../../design";
import drawer from "../details/DetailDrawer.module.css";
import styles from "./Helm.module.css";

/** A read-only `<pre>` with a title and a Copy button, scrolling inside a maximum height. */
export function CodeBlock(props: {
  title: string;
  text: string;
  testId: string;
}) {
  const { title, text } = props;
  return (
    <section className={drawer.section}>
      <div className={styles.blockHead}>
        <h4 className={drawer.heading}>{title}</h4>
        <CopyButton
          value={() => text}
          what={title.charAt(0).toLowerCase() + title.slice(1)}
        />
      </div>
      <pre className={styles.pre} data-testid={props.testId}>
        {text}
      </pre>
    </section>
  );
}
