//! Charts (F15), read from the index helm caches for each repo. Search runs while the user
//! types, so a parsed index is kept until its file changes.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;
use ts_rs::TS;

use super::{args, check_name, flag, lock, HelmBinary, LooseVersion};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::with_location;
use crate::resources::invalid;
use crate::tools::stamp;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChartVersion {
    pub version: String,
    pub app_version: Option<String>,
    pub description: Option<String>,
    /// RFC 3339, as the index has it.
    pub created: Option<String>,
    pub deprecated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChartSummary {
    pub repo: String,
    pub name: String,
    pub latest: ChartVersion,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RepoProblemKind {
    IndexMissing,
    IndexInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoProblem {
    pub repo: String,
    pub problem: RepoProblemKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChartSearch {
    pub charts: Vec<ChartSummary>,
    pub repo_problems: Vec<RepoProblem>,
}

/// Where helm keeps its repo list and the indexes it downloaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HelmDirs {
    pub(crate) repository_config: PathBuf,
    pub(crate) repository_cache: PathBuf,
}

/// `helm env` prints `KEY="value"` lines.
pub(crate) fn parse_env(stdout: &str) -> Option<HelmDirs> {
    let value = |key: &str| {
        stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix(key)?.strip_prefix('='))
            .map(|value| value.trim().trim_matches('"'))
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    Some(HelmDirs {
        repository_config: value("HELM_REPOSITORY_CONFIG")?,
        repository_cache: value("HELM_REPOSITORY_CACHE")?,
    })
}

#[derive(Deserialize)]
struct RepoFile {
    #[serde(default)]
    repositories: Option<Vec<RepoFileEntry>>,
}

/// Only the name. The file also holds passwords, which are never kept.
#[derive(Deserialize)]
struct RepoFileEntry {
    name: String,
}

pub(crate) fn parse_repo_names(text: &str) -> Result<Vec<String>, serde_yaml_ng::Error> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: RepoFile = serde_yaml_ng::from_str(text)?;
    let entries = file.repositories.unwrap_or_default();
    Ok(entries.into_iter().map(|entry| entry.name).collect())
}

/// One repo's index, as much of it as search and the version list need.
#[derive(Debug, Clone, Default)]
pub(crate) struct RepoIndex {
    /// By name.
    pub(crate) charts: Vec<IndexedChart>,
}

#[derive(Debug, Clone)]
pub(crate) struct IndexedChart {
    pub(crate) name: String,
    /// Newest first, versions that are not semver last.
    pub(crate) versions: Vec<ChartVersion>,
    /// Into `versions`: the newest without a pre-release part, or the newest of all.
    pub(crate) latest: usize,
    /// The latest version's.
    pub(crate) keywords: Vec<String>,
}

#[derive(Deserialize)]
struct IndexFile {
    #[serde(default)]
    entries: Option<BTreeMap<String, Option<Vec<IndexEntry>>>>,
}

/// A plain scalar read as `String` keeps its text, so `version: 1.0` stays `1.0`. The
/// fields that are free-form in practice are read as any YAML.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    version: Option<String>,
    app_version: Option<String>,
    description: Option<String>,
    created: Option<String>,
    #[serde(default)]
    deprecated: Value,
    #[serde(default)]
    keywords: Value,
}

fn texts(value: &Value) -> Vec<String> {
    let Value::Sequence(items) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .collect()
}

/// Newest first; versions that are not semver go last, in their order.
fn newest_first(left: Option<&LooseVersion>, right: Option<&LooseVersion>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => right.compare(left),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// Drops entries without a version, and charts whose every version is deprecated.
pub(crate) fn parse_index(text: &str) -> Result<RepoIndex, serde_yaml_ng::Error> {
    let file: IndexFile = serde_yaml_ng::from_str(text)?;
    let mut charts = Vec::new();
    for (name, entries) in file.entries.unwrap_or_default() {
        let mut versions: Vec<(Option<LooseVersion>, ChartVersion, Vec<String>)> = entries
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entry| {
                let version = entry.version?;
                let chart_version = ChartVersion {
                    deprecated: entry.deprecated == Value::Bool(true),
                    app_version: entry.app_version,
                    description: entry.description,
                    created: entry.created,
                    version: version.clone(),
                };
                Some((
                    LooseVersion::parse(&version),
                    chart_version,
                    texts(&entry.keywords),
                ))
            })
            .collect();
        if versions.iter().all(|(_, version, _)| version.deprecated) {
            continue;
        }
        versions.sort_by(|left, right| newest_first(left.0.as_ref(), right.0.as_ref()));
        let latest = versions
            .iter()
            .position(|(parsed, ..)| parsed.as_ref().is_some_and(|parsed| parsed.pre.is_none()))
            .unwrap_or(0);
        let keywords = versions[latest].2.clone();
        charts.push(IndexedChart {
            name,
            latest,
            keywords,
            versions: versions
                .into_iter()
                .map(|(_, version, _)| version)
                .collect(),
        });
    }
    Ok(RepoIndex { charts })
}

/// 0: the name starts with the query, 1: the name holds it, 2: the latest description or
/// a keyword does.
fn rank(chart: &IndexedChart, query: &str) -> Option<u8> {
    let name = chart.name.to_lowercase();
    if name.starts_with(query) {
        return Some(0);
    }
    if name.contains(query) {
        return Some(1);
    }
    let holds = |text: &str| text.to_lowercase().contains(query);
    let described = chart.versions[chart.latest]
        .description
        .as_deref()
        .is_some_and(holds);
    let tagged = chart.keywords.iter().any(|keyword| holds(keyword));
    (described || tagged).then_some(2)
}

/// Case-insensitive. Ties go by chart name, then repo name.
pub(crate) fn search_indexes(
    indexes: &[(String, Arc<RepoIndex>)],
    query: &str,
    limit: Option<u32>,
) -> Vec<ChartSummary> {
    let query = query.trim().to_lowercase();
    let mut found: Vec<(u8, &str, &IndexedChart)> = Vec::new();
    for (repo, index) in indexes {
        for chart in &index.charts {
            if let Some(rank) = rank(chart, &query) {
                found.push((rank, repo.as_str(), chart));
            }
        }
    }
    found.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.2.name.cmp(&b.2.name))
            .then_with(|| a.1.cmp(b.1))
    });
    let limit = limit.map_or(usize::MAX, |limit| limit as usize);
    found
        .into_iter()
        .take(limit)
        .map(|(_, repo, chart)| ChartSummary {
            repo: repo.to_owned(),
            name: chart.name.clone(),
            latest: chart.versions[chart.latest].clone(),
            keywords: chart.keywords.clone(),
        })
        .collect()
}

/// `repo/chart`, the form helm takes, from two names checked on their own.
pub(crate) fn chart_name(repo: &str, chart: &str) -> CoreResult<String> {
    check_name("repo", repo)?;
    check_name("chart", chart)?;
    Ok(format!("{repo}/{chart}"))
}

/// helm takes an empty version as "the latest", which is not what the user picked.
pub(crate) fn check_version(version: &str) -> CoreResult<()> {
    if version.trim().is_empty() {
        Err(invalid("the chart version is empty"))
    } else {
        Ok(())
    }
}

impl AppCore {
    /// From one `helm env` per helm binary.
    async fn helm_dirs(&self, helm: &HelmBinary) -> CoreResult<HelmDirs> {
        if let Some(dirs) = lock(&self.helm().dirs).get(&helm.path) {
            return Ok(dirs.clone());
        }
        let stdout = self.helm_read(helm, args(&["env"])).await?;
        let dirs = parse_env(&String::from_utf8_lossy(&stdout)).ok_or_else(|| {
            IpcError::new(
                ErrorCode::Internal,
                "helm env did not name the repository config and cache",
            )
        })?;
        lock(&self.helm().dirs).insert(helm.path.clone(), dirs.clone());
        Ok(dirs)
    }

    async fn repo_names(&self, dirs: &HelmDirs) -> CoreResult<Vec<String>> {
        let path = &dirs.repository_config;
        let text = match tokio::fs::read_to_string(path).await {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(IpcError::new(
                    ErrorCode::Internal,
                    format!(
                        "helm's repository file {} could not be read: {e}",
                        path.display()
                    ),
                ))
            }
        };
        parse_repo_names(&text).map_err(|e| {
            IpcError::new(
                ErrorCode::Internal,
                with_location("helm's repository file is not valid YAML", &e),
            )
        })
    }

    /// A repo's parsed index, read again only when its file changed.
    async fn repo_index(
        &self,
        dirs: &HelmDirs,
        repo: &str,
    ) -> Result<Arc<RepoIndex>, RepoProblemKind> {
        if check_name("repo", repo).is_err() {
            return Err(RepoProblemKind::IndexMissing);
        }
        let path = dirs.repository_cache.join(format!("{repo}-index.yaml"));
        let current = stamp(&path).ok_or(RepoProblemKind::IndexMissing)?;
        if let Some((seen, index)) = lock(&self.helm().indexes).get(&path) {
            if *seen == current {
                return Ok(index.clone());
            }
        }
        let file = path.clone();
        let parsed = tokio::task::spawn_blocking(move || {
            let text = std::fs::read_to_string(&file).ok()?;
            parse_index(&text).ok()
        })
        .await
        .ok()
        .flatten();
        let index = Arc::new(parsed.ok_or(RepoProblemKind::IndexInvalid)?);
        lock(&self.helm().indexes).insert(path, (current, index.clone()));
        Ok(index)
    }

    /// An empty query lists every chart. `None` means no limit.
    pub async fn helm_chart_search(
        &self,
        query: &str,
        limit: Option<u32>,
    ) -> CoreResult<ChartSearch> {
        let helm = self.helm_binary().await?;
        let dirs = self.helm_dirs(&helm).await?;
        let mut indexes = Vec::new();
        let mut repo_problems = Vec::new();
        for repo in self.repo_names(&dirs).await? {
            match self.repo_index(&dirs, &repo).await {
                Ok(index) => indexes.push((repo, index)),
                Err(problem) => repo_problems.push(RepoProblem { repo, problem }),
            }
        }
        Ok(ChartSearch {
            charts: search_indexes(&indexes, query, limit),
            repo_problems,
        })
    }

    /// Newest first.
    pub async fn helm_chart_versions(
        &self,
        repo: &str,
        chart: &str,
    ) -> CoreResult<Vec<ChartVersion>> {
        chart_name(repo, chart)?;
        let helm = self.helm_binary().await?;
        let dirs = self.helm_dirs(&helm).await?;
        let index = self
            .repo_index(&dirs, repo)
            .await
            .map_err(|problem| match problem {
                RepoProblemKind::IndexMissing => IpcError::new(
                    ErrorCode::NotFound,
                    format!("repo {repo} has no index yet; update it"),
                ),
                RepoProblemKind::IndexInvalid => IpcError::new(
                    ErrorCode::Internal,
                    format!("the index of repo {repo} could not be read; update it"),
                ),
            })?;
        index
            .charts
            .iter()
            .find(|entry| entry.name == chart)
            .map(|entry| entry.versions.clone())
            .ok_or_else(|| {
                IpcError::new(
                    ErrorCode::NotFound,
                    format!("repo {repo} has no chart {chart}"),
                )
            })
    }

    /// Untrusted markdown from the chart's author.
    pub async fn helm_chart_readme(
        &self,
        repo: &str,
        chart: &str,
        version: &str,
    ) -> CoreResult<String> {
        self.helm_show("readme", repo, chart, version).await
    }

    /// The chart's default values, as YAML.
    pub async fn helm_chart_values(
        &self,
        repo: &str,
        chart: &str,
        version: &str,
    ) -> CoreResult<String> {
        self.helm_show("values", repo, chart, version).await
    }

    async fn helm_show(
        &self,
        what: &str,
        repo: &str,
        chart: &str,
        version: &str,
    ) -> CoreResult<String> {
        let name = chart_name(repo, chart)?;
        check_version(version)?;
        let helm = self.helm_binary().await?;
        let call: Vec<OsString> = vec![
            "show".into(),
            what.into(),
            name.into(),
            flag("version", version),
        ];
        let stdout = self.helm_read(&helm, call).await?;
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INDEX: &str = r#"apiVersion: v1
entries:
  web:
  - apiVersion: v2
    appVersion: 1.16
    created: "2026-11-01T10:00:00.000000000+07:00"
    description: A web server
    digest: abc
    keywords:
    - http
    - 2
    name: web
    urls:
    - https://charts.example.test/web-1.0.tgz
    version: 1.0
    annotations:
      category: Infrastructure
    dependencies:
    - name: common
      version: 2.x.x
      repository: oci://registry.example.test/charts
  - appVersion: "1.17"
    description: A web server, now faster
    keywords: [http, proxy]
    version: 1.1.0
  - appVersion: "1.18"
    description: Next
    version: 1.2.0-rc.1
  - version: latest-build
    description: No semver here
  - description: No version at all
  old:
  - version: 0.1.0
    deprecated: true
  - version: 0.2.0
    deprecated: true
  mixed:
  - version: 0.3.0
    deprecated: true
  - version: 0.2.0
generated: "2026-11-09T09:00:00+07:00"
serverInfo: {}
"#;

    fn versions(chart: &IndexedChart) -> Vec<&str> {
        chart.versions.iter().map(|v| v.version.as_str()).collect()
    }

    #[test]
    fn an_index_keeps_names_and_versions_newest_first() {
        let index = parse_index(INDEX).unwrap();
        let names: Vec<&str> = index.charts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["mixed", "web"]);
        let web = &index.charts[1];
        assert_eq!(
            versions(web),
            ["1.2.0-rc.1", "1.1.0", "1.0", "latest-build"]
        );
        assert_eq!(web.versions[web.latest].version, "1.1.0");
        assert_eq!(web.keywords, ["http", "proxy"]);
        let first = &web.versions[2];
        assert_eq!(first.app_version.as_deref(), Some("1.16"));
        assert_eq!(first.description.as_deref(), Some("A web server"));
        assert_eq!(
            first.created.as_deref(),
            Some("2026-11-01T10:00:00.000000000+07:00")
        );
        assert!(!first.deprecated);
        let mixed = &index.charts[0];
        assert_eq!(versions(mixed), ["0.3.0", "0.2.0"]);
        assert!(mixed.versions[0].deprecated);
    }

    #[test]
    fn a_chart_with_only_pre_releases_takes_the_newest_as_latest() {
        let index =
            parse_index("entries:\n  x:\n  - version: 1.0.0-beta.1\n  - version: 1.0.0-beta.2\n")
                .unwrap();
        let x = &index.charts[0];
        assert_eq!(x.versions[x.latest].version, "1.0.0-beta.2");
    }

    #[test]
    fn empty_and_broken_indexes() {
        assert!(parse_index("apiVersion: v1\nentries: {}\n")
            .unwrap()
            .charts
            .is_empty());
        assert!(parse_index("apiVersion: v1\nentries:\n")
            .unwrap()
            .charts
            .is_empty());
        assert!(parse_index("apiVersion: v1\nentries:\n  x:\n")
            .unwrap()
            .charts
            .is_empty());
        assert!(parse_index("entries: [").is_err());
        assert!(parse_index("entries:\n  x:\n  - version: [1]\n").is_err());
    }

    fn index(charts: &[(&str, &str, &str)]) -> Arc<RepoIndex> {
        let mut text = String::from("entries:\n");
        for (name, description, keywords) in charts {
            text.push_str(&format!(
                "  {name}:\n  - version: 1.0.0\n    description: {description}\n    keywords: [{keywords}]\n"
            ));
        }
        Arc::new(parse_index(&text).unwrap())
    }

    #[test]
    fn search_ranks_a_name_prefix_then_a_name_then_the_description_and_keywords() {
        let indexes = vec![
            (
                "a".to_owned(),
                index(&[
                    ("redis", "A cache", "db"),
                    ("proxy", "Fronts NGINX", "edge"),
                    ("my-nginx", "Mine", ""),
                    ("nginx", "A web server", "http"),
                    ("tagged", "Nothing", "nginx-like"),
                ]),
            ),
            ("b".to_owned(), index(&[("nginx", "Another", "")])),
        ];
        let found = |query, limit| -> Vec<String> {
            search_indexes(&indexes, query, limit)
                .into_iter()
                .map(|c| format!("{}/{}", c.repo, c.name))
                .collect()
        };
        assert_eq!(
            found(" NGINX ", None),
            ["a/nginx", "b/nginx", "a/my-nginx", "a/proxy", "a/tagged"]
        );
        assert_eq!(found("nginx", Some(2)), ["a/nginx", "b/nginx"]);
        assert_eq!(
            found("", None),
            [
                "a/my-nginx",
                "a/nginx",
                "b/nginx",
                "a/proxy",
                "a/redis",
                "a/tagged"
            ]
        );
        assert!(found("nothing-matches", None).is_empty());
        let summary = &search_indexes(&indexes, "redis", None)[0];
        assert_eq!(summary.latest.version, "1.0.0");
        assert_eq!(summary.keywords, ["db"]);
    }

    #[test]
    fn helm_env_names_the_repository_config_and_cache() {
        let stdout = "HELM_BIN=\"helm\"\nHELM_CACHE_HOME=\"/c\"\nHELM_REPOSITORY_CACHE=\"/c/repository\"\nHELM_REPOSITORY_CONFIG=\"/h/repositories.yaml\"\n";
        assert_eq!(
            parse_env(stdout),
            Some(HelmDirs {
                repository_config: PathBuf::from("/h/repositories.yaml"),
                repository_cache: PathBuf::from("/c/repository"),
            })
        );
        assert_eq!(parse_env("HELM_REPOSITORY_CACHE=\"/c\"\n"), None);
        assert_eq!(
            parse_env("HELM_REPOSITORY_CONFIG=\"\"\nHELM_REPOSITORY_CACHE=\"/c\"\n"),
            None
        );
    }

    #[test]
    fn repo_names_come_from_the_repository_file_and_nothing_else() {
        let text = "apiVersion: \"\"\ngenerated: \"0001-01-01T00:00:00Z\"\nrepositories:\n- name: fixture\n  url: http://127.0.0.1:1\n  username: u\n  password: s3cret\n  insecure_skip_tls_verify: false\n- name: other\n  url: https://charts.example.test\n";
        assert_eq!(parse_repo_names(text).unwrap(), ["fixture", "other"]);
        assert!(parse_repo_names("").unwrap().is_empty());
        assert!(parse_repo_names("repositories: null\n").unwrap().is_empty());
        assert!(parse_repo_names("repositories: [\n").is_err());
    }

    #[test]
    fn a_chart_name_is_repo_slash_chart() {
        assert_eq!(
            chart_name("fixture", "skopos-fixture").unwrap(),
            "fixture/skopos-fixture"
        );
        assert_eq!(
            chart_name("-x", "a").unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            chart_name("a", "b/c").unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}
