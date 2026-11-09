//! Releases (F15): the list, one release's detail, values and history. helm's JSON differs
//! between versions, so it is read as plain JSON and each field is taken when it is there.

use std::ffi::OsString;
use std::path::Path;
use std::sync::LazyLock;

use futures::stream::{self, StreamExt};
use kube::core::discovery::Scope;
use kube::core::GroupVersionKind;
use kube::Discovery;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_yaml_ng::Value as Yaml;
use ts_rs::TS;

use super::{
    args, check_name, check_namespace, cluster_args, flag, parse_json, HelmBinary, LooseVersion,
};
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;
use crate::resources::ResourceRef;

/// Namespaces listed at once after listing every namespace was forbidden.
const LIST_CONCURRENCY: usize = 4;
/// Every state but `unknown`. helm 4 has no `--all`.
const STATES: [&str; 6] = [
    "--deployed",
    "--failed",
    "--pending",
    "--superseded",
    "--uninstalled",
    "--uninstalling",
];
/// `--max=0` is no limit for `helm list`, but no entries for `helm history`.
const HISTORY_MAX: &str = "--max=10000";

/// Go's default time format, which `helm list` prints.
static GO_TIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{2})(\d{2})(?: \S+)?$")
        .expect("valid pattern")
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: u32,
    /// helm's status, for example `deployed` or `pending-upgrade`.
    pub status: String,
    /// For example `nginx-1.2.3`.
    pub chart: String,
    pub chart_name: Option<String>,
    pub chart_version: Option<String>,
    pub app_version: Option<String>,
    /// RFC 3339.
    pub updated: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmReleaseList {
    pub releases: Vec<HelmRelease>,
    /// Listing every namespace was forbidden, so each accessible one was listed instead.
    pub partial: bool,
    pub failed_namespaces: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ManifestResource {
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    /// `None` when the cluster does not serve that kind.
    #[serde(rename = "ref")]
    pub resource: Option<ResourceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmReleaseDetail {
    #[serde(flatten)]
    pub release: HelmRelease,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
    pub resources: Vec<ManifestResource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRevision {
    pub revision: u32,
    pub updated: Option<String>,
    pub status: String,
    pub chart: String,
    pub app_version: Option<String>,
    pub description: Option<String>,
}

/// A string or number field as text. An empty string is no value.
fn text(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// helm 3 and 4 print the list's revision as a string and history's as a number.
fn number(value: &Value, key: &str) -> u32 {
    match value.get(key) {
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|number| u32::try_from(number).ok())
            .unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// RFC 3339 from Go's default format; other text is kept. Go's zero time is no time.
pub(crate) fn rfc3339(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.starts_with("0001-01-01") {
        return None;
    }
    Some(match GO_TIME.captures(text) {
        Some(parts) => format!("{}T{}{}:{}", &parts[1], &parts[2], &parts[3], &parts[4]),
        None => text.to_owned(),
    })
}

/// `name-version`, split at the first `-` that starts a three-part semver.
pub(crate) fn split_chart(chart: &str) -> (Option<String>, Option<String>) {
    for (index, _) in chart.match_indices('-') {
        let version = &chart[index + 1..];
        let core = version.split(['-', '+']).next().unwrap_or_default();
        if index > 0 && core.split('.').count() == 3 && LooseVersion::parse(version).is_some() {
            return (Some(chart[..index].to_owned()), Some(version.to_owned()));
        }
    }
    (None, None)
}

fn release_from(entry: &Value) -> Option<HelmRelease> {
    let name = text(entry, "name")?;
    let chart = text(entry, "chart").unwrap_or_default();
    let (chart_name, chart_version) = split_chart(&chart);
    Some(HelmRelease {
        name,
        namespace: text(entry, "namespace").unwrap_or_default(),
        revision: number(entry, "revision"),
        status: text(entry, "status").unwrap_or_default(),
        chart,
        chart_name,
        chart_version,
        app_version: text(entry, "app_version"),
        updated: text(entry, "updated").and_then(|time| rfc3339(&time)),
    })
}

/// Entries without a name are left out.
pub(crate) fn parse_release_list(stdout: &[u8]) -> CoreResult<Vec<HelmRelease>> {
    if stdout.trim_ascii().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<Value> = parse_json("release list", stdout)?;
    Ok(entries.iter().filter_map(release_from).collect())
}

/// Newest first.
pub(crate) fn parse_history(stdout: &[u8]) -> CoreResult<Vec<HelmRevision>> {
    if stdout.trim_ascii().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<Value> = parse_json("release history", stdout)?;
    let mut revisions: Vec<HelmRevision> = entries
        .iter()
        .map(|entry| HelmRevision {
            revision: number(entry, "revision"),
            updated: text(entry, "updated").and_then(|time| rfc3339(&time)),
            status: text(entry, "status").unwrap_or_default(),
            chart: text(entry, "chart").unwrap_or_default(),
            app_version: text(entry, "app_version"),
            description: text(entry, "description"),
        })
        .collect();
    revisions.sort_by_key(|entry| std::cmp::Reverse(entry.revision));
    Ok(revisions)
}

/// `helm status -o json` has no chart, so the chart and app version come from the history
/// entry of the current revision.
pub(crate) fn detail_from(
    status: &Value,
    history: &[HelmRevision],
    lookup: &dyn Fn(&str, &str) -> Option<ResourceRef>,
) -> HelmReleaseDetail {
    let info = &status["info"];
    let revision = number(status, "version");
    let current = history.iter().find(|entry| entry.revision == revision);
    let chart = current.map(|entry| entry.chart.clone()).unwrap_or_default();
    let (chart_name, chart_version) = split_chart(&chart);
    let namespace = text(status, "namespace").unwrap_or_default();
    let last_deployed = text(info, "last_deployed").and_then(|time| rfc3339(&time));
    let manifest = status["manifest"].as_str().unwrap_or_default();
    HelmReleaseDetail {
        resources: manifest_resources(manifest, &namespace, lookup),
        release: HelmRelease {
            name: text(status, "name").unwrap_or_default(),
            namespace,
            revision,
            status: text(info, "status").unwrap_or_default(),
            chart,
            chart_name,
            chart_version,
            app_version: current.and_then(|entry| entry.app_version.clone()),
            updated: current
                .and_then(|entry| entry.updated.clone())
                .or_else(|| last_deployed.clone()),
        },
        description: text(info, "description"),
        notes: text(info, "notes"),
        first_deployed: text(info, "first_deployed").and_then(|time| rfc3339(&time)),
        last_deployed,
    }
}

fn yaml_text(value: &Yaml, key: &str) -> Option<String> {
    match value.get(key)? {
        Yaml::String(text) if !text.is_empty() => Some(text.clone()),
        Yaml::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Each object in a rendered manifest, `List` items included. Documents are read as any
/// YAML, so a key YAML reads as a number does not lose the rest. Reading stops at the first
/// malformed document.
pub(crate) fn manifest_resources(
    manifest: &str,
    release_namespace: &str,
    lookup: &dyn Fn(&str, &str) -> Option<ResourceRef>,
) -> Vec<ManifestResource> {
    let mut resources = Vec::new();
    for document in serde_yaml_ng::Deserializer::from_str(manifest) {
        // After a malformed document the iterator yields the same error forever.
        let Ok(value) = Yaml::deserialize(document) else {
            break;
        };
        push_resources(&value, release_namespace, lookup, &mut resources);
    }
    resources
}

fn push_resources(
    value: &Yaml,
    release_namespace: &str,
    lookup: &dyn Fn(&str, &str) -> Option<ResourceRef>,
    out: &mut Vec<ManifestResource>,
) {
    let (Some(api_version), Some(kind)) =
        (yaml_text(value, "apiVersion"), yaml_text(value, "kind"))
    else {
        return;
    };
    if kind.ends_with("List") {
        if let Some(Yaml::Sequence(items)) = value.get("items") {
            for item in items {
                push_resources(item, release_namespace, lookup, out);
            }
            return;
        }
    }
    let Some(metadata) = value.get("metadata") else {
        return;
    };
    let Some(name) = yaml_text(metadata, "name") else {
        return;
    };
    let resource = lookup(&api_version, &kind);
    let namespace = match &resource {
        Some(served) if served.namespaced => {
            Some(yaml_text(metadata, "namespace").unwrap_or_else(|| release_namespace.to_owned()))
        }
        Some(_) => None,
        None => yaml_text(metadata, "namespace"),
    };
    out.push(ManifestResource {
        api_version,
        kind,
        namespace,
        name,
        resource,
    });
}

/// The resource type the cluster serves for a manifest's `apiVersion` and `kind`.
fn served(discovery: &Discovery, api_version: &str, kind: &str) -> Option<ResourceRef> {
    let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
    let wanted = GroupVersionKind::gvk(group, version, kind);
    let (resource, capabilities) = discovery.resolve_gvk(&wanted)?;
    Some(ResourceRef {
        group: resource.group,
        version: resource.version,
        plural: resource.plural,
        kind: resource.kind,
        namespaced: capabilities.scope == Scope::Namespaced,
    })
}

/// `None` lists every namespace.
fn list_args(kubeconfig: &Path, namespace: Option<&str>) -> Vec<OsString> {
    let mut call = args(&["list"]);
    match namespace {
        Some(namespace) => call.extend(cluster_args(kubeconfig, namespace)),
        None => {
            call.push(flag("kubeconfig", kubeconfig));
            call.push("--all-namespaces".into());
        }
    }
    call.extend(args(&STATES));
    call.extend(args(&["--max=0", "--output=json"]));
    call
}

/// `command` (which holds the release name), then the cluster, then `rest`.
fn release_call(
    command: &[&str],
    kubeconfig: &Path,
    namespace: &str,
    rest: &[&str],
) -> Vec<OsString> {
    let mut call = args(command);
    call.extend(cluster_args(kubeconfig, namespace));
    call.extend(args(rest));
    call
}

fn sorted(mut releases: Vec<HelmRelease>) -> Vec<HelmRelease> {
    releases.sort_by(|a, b| {
        a.namespace
            .cmp(&b.namespace)
            .then_with(|| a.name.cmp(&b.name))
    });
    releases
}

impl AppCore {
    /// `None` lists every namespace. When that is forbidden, each namespace the connection
    /// found is listed instead and the list is partial.
    pub async fn helm_release_list(
        &self,
        id: &ClusterId,
        namespaces: Option<Vec<String>>,
    ) -> CoreResult<HelmReleaseList> {
        for namespace in namespaces.iter().flatten() {
            check_namespace(namespace)?;
        }
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        if let Some(namespaces) = namespaces {
            return self.list_each(&helm, &kubeconfig, namespaces, false).await;
        }
        match self.list_in(&helm, &kubeconfig, None).await {
            Ok(releases) => Ok(HelmReleaseList {
                releases: sorted(releases),
                partial: false,
                failed_namespaces: Vec::new(),
            }),
            Err(error) if error.code == ErrorCode::Forbidden => {
                let namespaces = match self.cluster_state(id) {
                    ConnectionState::Connected { info } => info.namespaces,
                    _ => Vec::new(),
                };
                if namespaces.is_empty() {
                    return Err(error);
                }
                self.list_each(&helm, &kubeconfig, namespaces, true).await
            }
            Err(error) => Err(error),
        }
    }

    async fn list_in(
        &self,
        helm: &HelmBinary,
        kubeconfig: &Path,
        namespace: Option<&str>,
    ) -> CoreResult<Vec<HelmRelease>> {
        let stdout = self
            .helm_read(helm, list_args(kubeconfig, namespace))
            .await?;
        parse_release_list(&stdout)
    }

    /// Fails only when every namespace failed, with the first error.
    async fn list_each(
        &self,
        helm: &HelmBinary,
        kubeconfig: &Path,
        namespaces: Vec<String>,
        partial: bool,
    ) -> CoreResult<HelmReleaseList> {
        let count = namespaces.len();
        let results: Vec<(String, CoreResult<Vec<HelmRelease>>)> = stream::iter(namespaces)
            .map(|namespace| async move {
                let result = self.list_in(helm, kubeconfig, Some(&namespace)).await;
                (namespace, result)
            })
            .buffered(LIST_CONCURRENCY)
            .collect()
            .await;
        let mut releases = Vec::new();
        let mut failed_namespaces = Vec::new();
        let mut first_error = None;
        for (namespace, result) in results {
            match result {
                Ok(found) => releases.extend(found),
                Err(error) => {
                    failed_namespaces.push(namespace);
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Some(error) = first_error.filter(|_| failed_namespaces.len() == count) {
            return Err(error);
        }
        Ok(HelmReleaseList {
            releases: sorted(releases),
            partial,
            failed_namespaces,
        })
    }

    /// Status and history run at once; the manifest comes with the status.
    pub async fn helm_release_get(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
    ) -> CoreResult<HelmReleaseDetail> {
        check_namespace(namespace)?;
        check_name("release", name)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let discovery = self.cluster_discovery(id)?;
        let status_call = release_call(
            &["status", name],
            &kubeconfig,
            namespace,
            &["--output=json"],
        );
        let history_call = release_call(
            &["history", name],
            &kubeconfig,
            namespace,
            &[HISTORY_MAX, "--output=json"],
        );
        let (status, history) = tokio::join!(
            self.helm_read(&helm, status_call),
            self.helm_read(&helm, history_call)
        );
        let status: Value = parse_json("release status", &status?)?;
        let history = parse_history(&history?)?;
        let lookup = |api_version: &str, kind: &str| served(&discovery, api_version, kind);
        Ok(detail_from(&status, &history, &lookup))
    }

    /// YAML. `all`: the computed values; otherwise the ones the user gave, or "" for none.
    pub async fn helm_release_values(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        all: bool,
    ) -> CoreResult<String> {
        check_namespace(namespace)?;
        check_name("release", name)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let rest: &[&str] = if all {
            &["--all", "--output=yaml"]
        } else {
            &["--output=yaml"]
        };
        let call = release_call(&["get", "values", name], &kubeconfig, namespace, rest);
        let text = String::from_utf8_lossy(&self.helm_read(&helm, call).await?).into_owned();
        Ok(if text.trim() == "null" {
            String::new()
        } else {
            text
        })
    }

    /// Newest first.
    pub async fn helm_release_history(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
    ) -> CoreResult<Vec<HelmRevision>> {
        check_namespace(namespace)?;
        check_name("release", name)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let call = release_call(
            &["history", name],
            &kubeconfig,
            namespace,
            &[HISTORY_MAX, "--output=json"],
        );
        parse_history(&self.helm_read(&helm, call).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_times_become_rfc_3339() {
        assert_eq!(
            rfc3339("2026-11-09 09:25:49.373528822 +0700 +07").as_deref(),
            Some("2026-11-09T09:25:49.373528822+07:00")
        );
        assert_eq!(
            rfc3339("2026-11-09 02:25:49 +0000 UTC").as_deref(),
            Some("2026-11-09T02:25:49+00:00")
        );
        assert_eq!(
            rfc3339("2026-11-08 20:25:49.1 -0530 -0530").as_deref(),
            Some("2026-11-08T20:25:49.1-05:30")
        );
        assert_eq!(
            rfc3339("2026-11-09T09:25:49.373528822+07:00").as_deref(),
            Some("2026-11-09T09:25:49.373528822+07:00")
        );
        assert_eq!(rfc3339("0001-01-01 00:00:00 +0000 UTC"), None);
        assert_eq!(rfc3339("0001-01-01T00:00:00Z"), None);
        assert_eq!(rfc3339(" "), None);
    }

    #[test]
    fn chart_names_split_at_the_version() {
        let split = |chart| {
            let (name, version) = split_chart(chart);
            (name.unwrap_or_default(), version.unwrap_or_default())
        };
        assert_eq!(
            split("skopos-fixture-0.1.0"),
            ("skopos-fixture".into(), "0.1.0".into())
        );
        assert_eq!(split("web-2-1.0.0"), ("web-2".into(), "1.0.0".into()));
        assert_eq!(
            split("my-chart-1.2.3-rc.1+build.5"),
            ("my-chart".into(), "1.2.3-rc.1+build.5".into())
        );
        assert_eq!(split("app-v2.0.1"), ("app".into(), "v2.0.1".into()));
        for odd in ["odd", "x-1.0", "-1.0.0", ""] {
            assert_eq!(split_chart(odd), (None, None), "{odd}");
        }
    }

    #[test]
    fn a_release_list_reads_what_both_helm_versions_print() {
        let stdout = br#"[
            {"name":"rel","namespace":"skopos-test-helm","revision":"1","updated":"2026-11-09 09:25:49.373528822 +0700 +07","status":"deployed","chart":"skopos-fixture-0.1.0","app_version":"1.0.0"},
            {"name":"other","namespace":"default","revision":"12","updated":"2026-11-09 02:25:49 +0000 UTC","status":"pending-upgrade","chart":"web-2-1.0.0-rc.1","app_version":""},
            {"name":"n","namespace":"x","revision":3,"chart":"odd","status":"failed","extra":{"a":1}},
            {"namespace":"default"}
        ]"#;
        let releases = parse_release_list(stdout).unwrap();
        assert_eq!(releases.len(), 3);
        assert_eq!(
            releases[0],
            HelmRelease {
                name: "rel".into(),
                namespace: "skopos-test-helm".into(),
                revision: 1,
                status: "deployed".into(),
                chart: "skopos-fixture-0.1.0".into(),
                chart_name: Some("skopos-fixture".into()),
                chart_version: Some("0.1.0".into()),
                app_version: Some("1.0.0".into()),
                updated: Some("2026-11-09T09:25:49.373528822+07:00".into()),
            }
        );
        assert_eq!(releases[1].revision, 12);
        assert_eq!(releases[1].chart_name.as_deref(), Some("web-2"));
        assert_eq!(releases[1].app_version, None);
        assert_eq!(
            releases[1].updated.as_deref(),
            Some("2026-11-09T02:25:49+00:00")
        );
        assert_eq!(releases[2].revision, 3);
        assert_eq!(releases[2].chart_name, None);
        assert_eq!(releases[2].updated, None);
        assert!(parse_release_list(b"[]\n").unwrap().is_empty());
        assert!(parse_release_list(b"").unwrap().is_empty());
        assert_eq!(
            parse_release_list(b"{").unwrap_err().code,
            ErrorCode::Internal
        );
    }

    const HISTORY: &[u8] = br#"[
        {"revision":1,"updated":"2026-11-09T09:25:49.373528822+07:00","status":"superseded","chart":"skopos-fixture-0.1.0","app_version":"1.0.0","description":"Install complete"},
        {"revision":2,"updated":"2026-11-09T09:30:12.1+07:00","status":"deployed","chart":"skopos-fixture-0.2.0","app_version":"1.1.0","description":"Upgrade complete"}
    ]"#;

    #[test]
    fn history_comes_newest_first() {
        let history = parse_history(HISTORY).unwrap();
        let revisions: Vec<u32> = history.iter().map(|entry| entry.revision).collect();
        assert_eq!(revisions, [2, 1]);
        assert_eq!(
            history[1],
            HelmRevision {
                revision: 1,
                updated: Some("2026-11-09T09:25:49.373528822+07:00".into()),
                status: "superseded".into(),
                chart: "skopos-fixture-0.1.0".into(),
                app_version: Some("1.0.0".into()),
                description: Some("Install complete".into()),
            }
        );
        assert!(parse_history(b"[]").unwrap().is_empty());
    }

    fn lookup(api_version: &str, kind: &str) -> Option<ResourceRef> {
        let (group, version, plural, namespaced) = match (api_version, kind) {
            ("v1", "ConfigMap") => ("", "v1", "configmaps", true),
            ("apps/v1", "Deployment") => ("apps", "v1", "deployments", true),
            ("rbac.authorization.k8s.io/v1", "ClusterRole") => {
                ("rbac.authorization.k8s.io", "v1", "clusterroles", false)
            }
            _ => return None,
        };
        Some(ResourceRef {
            group: group.into(),
            version: version.into(),
            plural: plural.into(),
            kind: kind.into(),
            namespaced,
        })
    }

    /// Kind, name, namespace and the served plural.
    type Row = (String, String, Option<String>, Option<String>);

    fn found(resources: &[ManifestResource]) -> Vec<Row> {
        resources
            .iter()
            .map(|r| {
                (
                    r.kind.clone(),
                    r.name.clone(),
                    r.namespace.clone(),
                    r.resource.as_ref().map(|served| served.plural.clone()),
                )
            })
            .collect()
    }

    fn row(kind: &str, name: &str, namespace: Option<&str>, plural: Option<&str>) -> Row {
        (
            kind.into(),
            name.into(),
            namespace.map(Into::into),
            plural.map(Into::into),
        )
    }

    #[test]
    fn manifest_resources_flatten_lists_and_follow_discovery() {
        let manifest = "---
# Source: x/templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rel-config
data:
  1: numbered key
---
# Source: x/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rel-web
  namespace: elsewhere
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: rel-reader
  namespace: ignored
---
apiVersion: v1
kind: List
items:
- apiVersion: v1
  kind: ConfigMap
  metadata:
    name: listed
- apiVersion: example.test/v1
  kind: Widget
  metadata:
    name: gadget
---
# Source: x/templates/empty.yaml
---
apiVersion: v1
kind: Secret
metadata: {}
---
just text
";
        let resources = manifest_resources(manifest, "rel-ns", &lookup);
        assert_eq!(
            found(&resources),
            [
                row(
                    "ConfigMap",
                    "rel-config",
                    Some("rel-ns"),
                    Some("configmaps")
                ),
                row(
                    "Deployment",
                    "rel-web",
                    Some("elsewhere"),
                    Some("deployments")
                ),
                row("ClusterRole", "rel-reader", None, Some("clusterroles")),
                row("ConfigMap", "listed", Some("rel-ns"), Some("configmaps")),
                row("Widget", "gadget", None, None),
            ]
        );
        assert_eq!(resources[4].api_version, "example.test/v1");
        assert!(manifest_resources("", "rel-ns", &lookup).is_empty());
    }

    /// A hang here means the loop did not stop at the first error, which the YAML
    /// iterator repeats forever.
    #[test]
    fn a_bad_document_ends_the_resources() {
        let manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: first}\n---\nbad: [\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: after}\n";
        let resources = manifest_resources(manifest, "rel-ns", &lookup);
        assert_eq!(
            found(&resources),
            [row(
                "ConfigMap",
                "first",
                Some("rel-ns"),
                Some("configmaps")
            )]
        );
    }

    #[test]
    fn the_detail_takes_chart_and_app_version_from_the_current_revision() {
        let status: Value = serde_json::from_str(r##"{
            "name": "rel",
            "info": {
                "first_deployed": "2026-11-09T09:25:49.373528822+07:00",
                "last_deployed": "2026-11-09T09:30:12.1+07:00",
                "deleted": "",
                "description": "Upgrade complete",
                "status": "deployed",
                "notes": "Release rel holds hello.",
                "resources": {}
            },
            "manifest": "---\n# Source: skopos-fixture/templates/configmap.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rel-config\ndata:\n  message: \"hello\"\n",
            "version": 2,
            "namespace": "skopos-test-helm",
            "apply_method": "ssa"
        }"##)
        .unwrap();
        let history = parse_history(HISTORY).unwrap();
        let detail = detail_from(&status, &history, &lookup);
        assert_eq!(
            detail.release,
            HelmRelease {
                name: "rel".into(),
                namespace: "skopos-test-helm".into(),
                revision: 2,
                status: "deployed".into(),
                chart: "skopos-fixture-0.2.0".into(),
                chart_name: Some("skopos-fixture".into()),
                chart_version: Some("0.2.0".into()),
                app_version: Some("1.1.0".into()),
                updated: Some("2026-11-09T09:30:12.1+07:00".into()),
            }
        );
        assert_eq!(detail.description.as_deref(), Some("Upgrade complete"));
        assert_eq!(detail.notes.as_deref(), Some("Release rel holds hello."));
        assert_eq!(
            detail.first_deployed.as_deref(),
            Some("2026-11-09T09:25:49.373528822+07:00")
        );
        assert_eq!(
            found(&detail.resources),
            [row(
                "ConfigMap",
                "rel-config",
                Some("skopos-test-helm"),
                Some("configmaps")
            )]
        );

        // With no matching history entry the chart is unknown, and `updated` falls back.
        let detail = detail_from(&status, &[], &lookup);
        assert_eq!(detail.release.chart, "");
        assert_eq!(detail.release.chart_name, None);
        assert_eq!(
            detail.release.updated.as_deref(),
            Some("2026-11-09T09:30:12.1+07:00")
        );
        let json = serde_json::to_value(&detail).unwrap();
        assert_eq!(json["name"], "rel");
        assert_eq!(json["resources"][0]["ref"]["plural"], "configmaps");
    }
}
