import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { IconButton, Input } from "../../design";
import styles from "./LogsTab.module.css";

/** The search field, its count and the match arrows (spec §6.1, §6.8). */
export function LogsSearch(props: {
  query: string;
  hits: string;
  hasMatches: boolean;
  onQuery(query: string): void;
  onStep(direction: 1 | -1): void;
}) {
  return (
    <>
      <div className={styles.search}>
        <Search size={14} aria-hidden="true" className={styles.searchIcon} />
        <Input
          className={styles.searchInput}
          type="text"
          placeholder="Search logs"
          aria-label="Search logs"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            props.onStep(e.shiftKey ? -1 : 1);
          }}
          data-testid="logs-search"
        />
      </div>
      <span className={styles.hits} data-testid="logs-hits">
        {props.hits}
      </span>
      <IconButton
        label="Previous match"
        icon={<ChevronUp size={16} aria-hidden="true" />}
        disabled={!props.hasMatches}
        onClick={() => props.onStep(-1)}
        data-testid="logs-prev-match"
      />
      <IconButton
        label="Next match"
        icon={<ChevronDown size={16} aria-hidden="true" />}
        disabled={!props.hasMatches}
        onClick={() => props.onStep(1)}
        data-testid="logs-next-match"
      />
    </>
  );
}
