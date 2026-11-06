//! The connect sequence: from a catalog entry to a client and a `ClusterInfo`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use k8s_openapi::api::core::v1::{Namespace, Node};
use kube::api::{ListParams, PostParams};
use kube::client::AuthError;
use kube::config::{KubeConfigOptions, Kubeconfig, KubeconfigError};
use kube::{Api, Client, Config, Discovery};
use tokio::time::{timeout, timeout_at, Instant};

use super::distribution::detect_distribution;
use super::manager::{ClusterHandle, LogLevel};
use super::state::{ClusterInfo, FailureKind};
use crate::error::{
    auth_error_text, error_chain, find_auth_error, friendly_transport_message, sanitize_text,
    ErrorCode,
};
use crate::kubeconfig::{extract_context, ContextEntry};
use crate::prefs::ClusterSettings;

/// Spec F3 only bounds `GET /version`, but a server that stalls afterwards must
/// not leave the cluster connecting forever. This is roomy, because discovery
/// on an old server takes one request per API group.
const LATER_STEP_LIMIT: Duration = Duration::from_secs(60);
const NODE_LIST_LIMIT: u32 = 50;

#[derive(Debug, Clone)]
pub struct ConnectTimeouts {
    pub version: Duration,
    /// Plugins can prompt in a browser.
    pub version_exec: Duration,
}

impl Default for ConnectTimeouts {
    fn default() -> Self {
        Self {
            version: Duration::from_secs(15),
            version_exec: Duration::from_secs(120),
        }
    }
}

#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) kind: FailureKind,
    pub(crate) message: String,
    /// The sanitized original text when `message` was reworded; it goes to the log.
    pub(crate) detail: Option<String>,
}

impl Failure {
    pub(crate) fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: sanitize_text(&message.into()),
            detail: None,
        }
    }

    /// A transport failure: people get plain wording, the log keeps the original.
    fn transport(message: String) -> Self {
        match friendly_transport_message(&message) {
            Some(friendly) => Self {
                kind: FailureKind::Unreachable,
                message: friendly,
                detail: Some(sanitize_text(&message)),
            },
            None => Self::new(FailureKind::Unreachable, message),
        }
    }

    fn config(message: impl Into<String>) -> Self {
        Self::new(FailureKind::ConfigInvalid, message)
    }
}

pub(crate) struct Established {
    pub(crate) client: Client,
    pub(crate) discovery: Arc<Discovery>,
    pub(crate) info: ClusterInfo,
}

/// Writes the per-context kubeconfig to `dest` and reads it back.
pub(crate) fn prepare_kubeconfig(entry: &ContextEntry, dest: &Path) -> Result<Kubeconfig, Failure> {
    extract_context(Path::new(&entry.source_path), &entry.context_name, dest).map_err(|e| {
        let kind = match e.code {
            ErrorCode::InvalidInput | ErrorCode::NotFound => FailureKind::ConfigInvalid,
            _ => FailureKind::Other,
        };
        let message = match e.code {
            ErrorCode::InvalidInput => e.message,
            _ => format!(
                "cannot prepare a kubeconfig from {}: {}",
                entry.source_path, e.message
            ),
        };
        Failure::new(kind, message)
    })?;
    Kubeconfig::read_from(dest).map_err(|e| config_failure(&entry.source_path, &e))
}

fn config_failure(source: &str, err: &KubeconfigError) -> Failure {
    match err {
        // The parser's text can quote the file, and so a credential.
        KubeconfigError::Parse(_) => Failure::config(format!(
            "{source} has a field of an unexpected type or format"
        )),
        _ => Failure::config(format!("{source}: {err}")),
    }
}

/// The command of the context's exec plugin, from the extracted kubeconfig.
fn exec_command(kubeconfig: &Kubeconfig) -> Option<String> {
    kubeconfig.auth_infos.iter().find_map(|named| {
        let exec = named.auth_info.as_ref()?.exec.as_ref()?;
        exec.command.clone()
    })
}

fn timed_out(what: &str, limit: Duration) -> Failure {
    Failure::new(
        FailureKind::Unreachable,
        format!("{what} timed out after {limit:?}"),
    )
}

/// Turns errors into `Failure`s, naming the context's exec plugin where it matters.
struct Classifier {
    exec_command: Option<String>,
}

impl Classifier {
    fn plugin_name(&self) -> String {
        match &self.exec_command {
            Some(command) => format!("exec plugin \"{command}\""),
            None => "the exec plugin".to_owned(),
        }
    }

    fn classify(&self, err: &kube::Error) -> Failure {
        if let Some(auth) = find_auth_error(err) {
            return self.classify_auth(auth);
        }
        match err {
            kube::Error::Api(status) => {
                let kind = match status.code {
                    401 => FailureKind::Unauthorized,
                    403 => FailureKind::Forbidden,
                    408 | 429 | 502 | 503 | 504 => FailureKind::Unreachable,
                    _ => FailureKind::Other,
                };
                let message = if status.message.is_empty() {
                    status.reason.clone()
                } else {
                    status.message.clone()
                };
                Failure::new(kind, message)
            }
            kube::Error::Service(_) | kube::Error::HyperError(_) | kube::Error::HttpError(_) => {
                Failure::transport(error_chain(err))
            }
            kube::Error::ProxyProtocolUnsupported { proxy_url } => Failure::config(format!(
                "the proxy URL uses an unsupported protocol: {}",
                proxy_url.scheme_str().unwrap_or("none")
            )),
            kube::Error::ProxyProtocolDisabled { .. }
            | kube::Error::RustlsTls(_)
            | kube::Error::TlsRequired
            | kube::Error::InferKubeconfig(_) => Failure::config(error_chain(err)),
            _ => Failure::new(FailureKind::Other, error_chain(err)),
        }
    }

    fn classify_auth(&self, err: &AuthError) -> Failure {
        if matches!(err, AuthError::AuthExecRun { .. }) {
            return Failure::new(FailureKind::Other, auth_error_text(err));
        }
        if let Some(detail) = exec_failure_detail(err) {
            let name = self.plugin_name();
            return Failure::new(FailureKind::Other, format!("{name} {detail}"));
        }
        let kind = match err {
            AuthError::InvalidBasicAuth(_)
            | AuthError::InvalidBearerToken(_)
            | AuthError::ReadTokenFile(..) => FailureKind::ConfigInvalid,
            _ => FailureKind::Unauthorized,
        };
        Failure::new(kind, err.to_string())
    }
}

/// What went wrong on the exec path, other than the plugin failing, which
/// `auth_error_text` covers. It is written here and not taken from `AuthError`'s
/// text, which can quote the plugin's stdout, where the credential is.
fn exec_failure_detail(err: &AuthError) -> Option<String> {
    Some(match err {
        AuthError::AuthExecStart(source) => format!("could not start: {source}"),
        AuthError::AuthExecParse(_) | AuthError::AuthExecSerialize(_) => {
            "printed something other than an ExecCredential".to_owned()
        }
        AuthError::ExecPluginFailed => "returned no status".to_owned(),
        AuthError::MalformedTokenExpirationDate(_) => {
            "returned a malformed token expiration date".to_owned()
        }
        AuthError::MissingCommand | AuthError::ExecMissingClusterInfo | AuthError::AuthExec(_) => {
            format!("failed: {err}")
        }
        _ => return None,
    })
}

/// Everything after `prepare_kubeconfig`. The caller races this against cancellation.
pub(crate) async fn establish(
    handle: &ClusterHandle,
    kubeconfig: Kubeconfig,
    entry: &ContextEntry,
    settings: &ClusterSettings,
    timeouts: &ConnectTimeouts,
) -> Result<Established, Failure> {
    let classifier = Classifier {
        exec_command: exec_command(&kubeconfig),
    };
    let limit = if entry.uses_exec {
        timeouts.version_exec
    } else {
        timeouts.version
    };
    // One allowance for both, because `kube` runs an exec plugin while building the client.
    let deadline = Instant::now() + limit;

    let client = build_client(kubeconfig, entry, settings, &classifier, deadline, limit).await?;

    handle.log(LogLevel::Info, "checking version");
    let version = timeout_at(deadline, client.apiserver_version())
        .await
        .map_err(|_| timed_out("GET /version", limit))?
        .map_err(|e| classifier.classify(&e))?;

    handle.log(LogLevel::Info, "running discovery");
    let discovery = timeout(LATER_STEP_LIMIT, run_discovery(handle, client.clone()))
        .await
        .map_err(|_| timed_out("discovery", LATER_STEP_LIMIT))?
        .map_err(|e| classifier.classify(&e))?;

    handle.log(LogLevel::Info, "listing namespaces");
    let (namespaces, namespaces_restricted) =
        list_namespaces(handle, &client, entry, settings, &classifier).await?;

    handle.log(LogLevel::Info, "checking access");
    let is_admin = check_admin(handle, &client).await;

    handle.log(LogLevel::Info, "collecting metadata");
    let nodes = collect_nodes(handle, &client).await;

    let api_groups: Vec<String> = discovery.groups().map(|g| g.name().to_owned()).collect();
    let info = ClusterInfo {
        distribution: detect_distribution(
            &version.git_version,
            &nodes.labels,
            &api_groups,
            &nodes.provider_ids,
        ),
        version: version.git_version,
        node_count: nodes.count,
        namespaces,
        namespaces_restricted,
        is_admin,
    };
    Ok(Established {
        client,
        discovery: Arc::new(discovery),
        info,
    })
}

async fn build_client(
    kubeconfig: Kubeconfig,
    entry: &ContextEntry,
    settings: &ClusterSettings,
    classifier: &Classifier,
    deadline: Instant,
    limit: Duration,
) -> Result<Client, Failure> {
    let options = KubeConfigOptions {
        context: Some(entry.context_name.clone()),
        ..Default::default()
    };
    let mut config = Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|e| config_failure(&entry.source_path, &e))?;
    let proxy_url = settings.proxy_url.as_deref().map(str::trim);
    if let Some(url) = proxy_url.filter(|url| !url.is_empty()) {
        // The error text does not quote the URL, which can hold a password.
        let parsed = url
            .parse::<http::Uri>()
            .map_err(|e| Failure::config(format!("the proxy URL setting is invalid: {e}")))?;
        config.proxy_url = Some(parsed);
    }
    // A 429 is an answer to show, such as an eviction a disruption budget refuses.
    // The default retry would hold the user's action for minutes.
    config.default_retry = false;
    // Blocks for as long as an exec plugin runs, and cannot be stopped once started.
    let build = tokio::task::spawn_blocking(move || Client::try_from(config));
    timeout_at(deadline, build)
        .await
        .map_err(|_| {
            let what = match classifier.exec_command {
                Some(_) => classifier.plugin_name(),
                None => "building the client".to_owned(),
            };
            timed_out(&what, limit)
        })?
        .map_err(|e| {
            Failure::new(
                FailureKind::Other,
                format!("building the client failed: {e}"),
            )
        })?
        .map_err(|e| match e {
            // Nothing has been requested yet, so a transport error here is a bad setting.
            kube::Error::HyperError(_) | kube::Error::HttpError(_) | kube::Error::Service(_) => {
                Failure::config(error_chain(&e))
            }
            _ => classifier.classify(&e),
        })
}

pub(super) async fn run_discovery(
    handle: &ClusterHandle,
    client: Client,
) -> kube::Result<Discovery> {
    let aggregated = Discovery::new(client.clone()).run_aggregated().await;
    // A server without aggregated discovery answers in another format, or not at all.
    // A real problem, such as bad credentials, shows up again in the fallback.
    if let Ok(discovery) = aggregated {
        if discovery.groups().next().is_some() {
            return Ok(discovery);
        }
    }
    handle.log(
        LogLevel::Info,
        "aggregated discovery is not available, querying each API group",
    );
    Discovery::new(client).run().await
}

/// The namespaces to offer, and whether they come from a fallback.
async fn list_namespaces(
    handle: &ClusterHandle,
    client: &Client,
    entry: &ContextEntry,
    settings: &ClusterSettings,
    classifier: &Classifier,
) -> Result<(Vec<String>, bool), Failure> {
    let api = Api::<Namespace>::all(client.clone());
    let listed = timeout(LATER_STEP_LIMIT, api.list(&ListParams::default()))
        .await
        .map_err(|_| timed_out("listing namespaces", LATER_STEP_LIMIT))?;
    match listed {
        Ok(list) => {
            let names = list
                .items
                .into_iter()
                .filter_map(|namespace| namespace.metadata.name)
                .collect();
            Ok((names, false))
        }
        Err(kube::Error::Api(status)) if status.code == 403 => {
            let (names, origin) = fallback_namespaces(entry, settings);
            handle.log(
                LogLevel::Warn,
                format!(
                    "not allowed to list namespaces, using {origin}: {}",
                    names.join(", ")
                ),
            );
            Ok((names, true))
        }
        Err(e) => Err(classifier.classify(&e)),
    }
}

fn fallback_namespaces(
    entry: &ContextEntry,
    settings: &ClusterSettings,
) -> (Vec<String>, &'static str) {
    if !settings.accessible_namespaces.is_empty() {
        return (
            settings.accessible_namespaces.clone(),
            "the accessible namespaces setting",
        );
    }
    match entry.namespace.as_deref().filter(|n| !n.is_empty()) {
        Some(namespace) => (vec![namespace.to_owned()], "the context's namespace"),
        None => (vec!["default".to_owned()], "the default namespace"),
    }
}

async fn check_admin(handle: &ClusterHandle, client: &Client) -> bool {
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                verb: Some("*".to_owned()),
                resource: Some("*".to_owned()),
                group: Some("*".to_owned()),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let api = Api::<SelfSubjectAccessReview>::all(client.clone());
    let answer = timeout(
        LATER_STEP_LIMIT,
        api.create(&PostParams::default(), &review),
    )
    .await;
    let failed = match answer {
        Ok(Ok(review)) => return review.status.is_some_and(|status| status.allowed),
        Ok(Err(e)) => error_chain(&e),
        Err(_) => format!("timed out after {LATER_STEP_LIMIT:?}"),
    };
    handle.log(
        LogLevel::Warn,
        format!("cannot check admin access: {failed}"),
    );
    false
}

#[derive(Default)]
struct NodeFacts {
    count: Option<u32>,
    labels: Vec<BTreeMap<String, String>>,
    provider_ids: Vec<String>,
}

async fn collect_nodes(handle: &ClusterHandle, client: &Client) -> NodeFacts {
    let api = Api::<Node>::all(client.clone());
    let params = ListParams::default().limit(NODE_LIST_LIMIT);
    let failed = match timeout(LATER_STEP_LIMIT, api.list(&params)).await {
        Ok(Ok(list)) => {
            // The server reports what lies past the limit, where it can count that.
            let past_limit = list.metadata.remaining_item_count.unwrap_or(0);
            let count = i64::try_from(list.items.len())
                .ok()
                .and_then(|listed| u32::try_from(listed + past_limit).ok());
            let mut facts = NodeFacts {
                count,
                ..Default::default()
            };
            for node in list.items {
                facts.labels.extend(node.metadata.labels);
                facts
                    .provider_ids
                    .extend(node.spec.and_then(|spec| spec.provider_id));
            }
            return facts;
        }
        Ok(Err(e)) => error_chain(&e),
        Err(_) => format!("timed out after {LATER_STEP_LIMIT:?}"),
    };
    handle.log(LogLevel::Warn, format!("cannot list nodes: {failed}"));
    NodeFacts::default()
}
