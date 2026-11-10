import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import {
  Button,
  EmptyState,
  ErrorNotice,
  IconButton,
  Spinner,
} from "../../design";
import { isToolMissing, useHelm } from "../../stores/helm";
import styles from "./PreferencesScreen.module.css";
import { RepoAddDialog, RepoRemoveDialog } from "./RepoDialogs";

/** The anchor Charts opens Preferences at. */
export const HELM_REPOSITORIES_ANCHOR = "helm-repositories";

/** Preferences › Helm repositories (spec §12.2). */
export function HelmReposSection() {
  const { hash } = useLocation();
  const list = useHelm((s) => s.repos.list);
  const error = useHelm((s) => s.repos.error);
  const updating = useHelm((s) => s.repos.updating);
  const ensureRepos = useHelm((s) => s.ensureRepos);
  const ensureCharts = useHelm((s) => s.ensureCharts);
  const loadRepos = useHelm((s) => s.loadRepos);
  const updateRepos = useHelm((s) => s.updateRepos);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    void ensureRepos();
    void ensureCharts();
  }, [ensureRepos, ensureCharts]);

  useEffect(() => {
    if (hash === `#${HELM_REPOSITORIES_ANCHOR}`) {
      ref.current?.scrollIntoView({ block: "start" });
    }
  }, [hash]);

  const missing = error !== null && isToolMissing(error);
  let body = null;
  if (missing) {
    body = (
      <p className={styles.muted} data-testid="pref-repos-missing">
        helm is missing. Download it under Tools.
      </p>
    );
  } else if (error) {
    body = (
      <ErrorNotice
        title="Could not read the chart repositories"
        message={error.message}
        details={error.details}
        onRetry={() => {
          void loadRepos();
        }}
      />
    );
  } else if (list === null) {
    body = <Spinner />;
  } else if (list.length === 0) {
    body = (
      <div data-testid="pref-repos-empty">
        <EmptyState title="No repositories. Add one to browse its charts." />
      </div>
    );
  } else {
    body = (
      <ul className={styles.rows}>
        {list.map((repo) => (
          <li
            key={repo.name}
            className={styles.row}
            data-testid={`pref-repo-${repo.name}`}
          >
            <span className={styles.repoName}>{repo.name}</span>
            <span className={styles.path} title={repo.url}>
              {repo.url}
            </span>
            {updating.includes(repo.name) ? (
              <span className={styles.updating}>
                <Spinner />
                Updating
              </span>
            ) : (
              <>
                <IconButton
                  label={`Update ${repo.name}`}
                  icon={<RefreshCw size={14} aria-hidden="true" />}
                  onClick={() => {
                    void updateRepos([repo.name]);
                  }}
                  data-testid={`pref-repo-update-${repo.name}`}
                />
                <IconButton
                  label={`Remove repository ${repo.name}`}
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  onClick={() => setRemoving(repo.name)}
                  data-testid={`pref-repo-remove-${repo.name}`}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section
      ref={ref}
      id={HELM_REPOSITORIES_ANCHOR}
      className={styles.section}
      data-testid="pref-repos"
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>
          <h3 className={styles.heading}>Helm repositories</h3>
          <p className={styles.muted}>
            helm's own list in repositories.yaml, so it matches your CLI.
          </p>
        </div>
        <Button
          size="sm"
          disabled={
            missing || !list || list.length === 0 || updating.length > 0
          }
          onClick={() => {
            void updateRepos(null);
          }}
          data-testid="pref-repos-update-all"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Update all
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={missing}
          onClick={() => setAdding(true)}
          data-testid="pref-repos-add"
        >
          <Plus size={14} aria-hidden="true" />
          Add repository
        </Button>
      </div>
      {body}
      {adding ? <RepoAddDialog onClose={() => setAdding(false)} /> : null}
      {removing !== null ? (
        <RepoRemoveDialog name={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </section>
  );
}
