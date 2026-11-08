import { Ellipsis } from "lucide-react";
import { IconButton, Menu } from "../../design";
import styles from "./ObjectActionBar.module.css";
import type { ObjectActionItem } from "./objectActions";
import { menuItems } from "./ResourceActions";

/**
 * The drawer header's actions: an icon button for each top item, then More actions
 * with the whole list, the same one the row menu shows.
 */
export function ObjectActionBar(props: { items: ObjectActionItem[] }) {
  const { items } = props;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a header toolbar does not want.
    <div
      role="group"
      aria-label="Actions"
      className={styles.bar}
      data-testid="detail-actions"
    >
      {items
        .filter((it) => it.top)
        .map((it) => {
          const Icon = it.icon;
          return (
            <IconButton
              key={it.id}
              label={it.label}
              icon={<Icon size={16} aria-hidden="true" />}
              disabled={it.disabled}
              onClick={it.run}
              data-testid={`detail-action-${it.id}`}
            />
          );
        })}
      {items.some((it) => !it.top) ? (
        <Menu
          trigger={
            <IconButton
              label="More actions"
              tooltip={false}
              icon={<Ellipsis size={16} aria-hidden="true" />}
              data-testid="detail-more-actions"
            />
          }
          items={menuItems(items)}
        />
      ) : null}
    </div>
  );
}
