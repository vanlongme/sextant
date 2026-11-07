//! A kubeconfig for one ServiceAccount, written straight to a file. The token comes from the
//! TokenRequest API and never crosses IPC (section 5.5 of the milestone spec): only its
//! expiry is returned.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use k8s_openapi::api::authentication::v1::{TokenRequest, TokenRequestSpec};
use k8s_openapi::api::core::v1::ServiceAccount;
use kube::api::PostParams;
use kube::Api;
use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

use super::ops::{invalid, is_path_segment};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{write_private, ClusterId};

const DEFAULT_LIFETIME_SECONDS: i64 = 3600;
/// The fields of a cluster entry that a saved kubeconfig keeps.
const KEPT_FIELDS: [&str; 5] = [
    "server",
    "certificate-authority-data",
    "insecure-skip-tls-verify",
    "proxy-url",
    "tls-server-name",
];

/// What saving returns. The token stays out of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SavedKubeconfig {
    pub expires_at: String,
}

/// The cluster entry for the new file. A CA file becomes data, because the path means nothing
/// wherever the file ends up.
fn portable_cluster(
    cluster: &Value,
    read_ca: impl Fn(&str) -> std::io::Result<Vec<u8>>,
) -> CoreResult<Value> {
    let mut kept = serde_json::Map::new();
    for field in KEPT_FIELDS {
        if let Some(value) = cluster.get(field) {
            kept.insert(field.to_owned(), value.clone());
        }
    }
    if !kept.contains_key("certificate-authority-data") {
        if let Some(path) = cluster.get("certificate-authority").and_then(Value::as_str) {
            let bytes = read_ca(path).map_err(|_| {
                IpcError::new(ErrorCode::Internal, "the cluster's CA file cannot be read")
            })?;
            kept.insert(
                "certificate-authority-data".to_owned(),
                json!(STANDARD.encode(bytes)),
            );
        }
    }
    Ok(Value::Object(kept))
}

fn kubeconfig_document(cluster: Value, namespace: &str, name: &str, token: &str) -> Value {
    let label = format!("{name}@{namespace}");
    json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{ "name": label, "cluster": cluster }],
        "users": [{ "name": label, "user": { "token": token } }],
        "contexts": [{
            "name": label,
            "context": { "cluster": label, "user": label, "namespace": namespace },
        }],
        "current-context": label,
    })
}

fn check_destination(dest: &Path) -> CoreResult<()> {
    if !dest.is_absolute() {
        return Err(invalid("the destination path must be absolute"));
    }
    if !dest.parent().is_some_and(Path::is_dir) {
        return Err(invalid("the destination folder does not exist"));
    }
    Ok(())
}

fn no_token() -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        "the API server returned no usable token",
    )
}

impl AppCore {
    /// Requests a token for the ServiceAccount, writes a kubeconfig using it to `dest` with
    /// mode 0600 on Unix, and returns when the token expires. The destination is checked
    /// first, so a bad path spends no token.
    pub async fn service_account_kubeconfig_save(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        dest: &Path,
        expiration_seconds: Option<i64>,
    ) -> CoreResult<SavedKubeconfig> {
        if !is_path_segment(namespace) || !is_path_segment(name) {
            return Err(invalid("the namespace or name is not valid"));
        }
        check_destination(dest)?;
        let client = self.cluster_client(id)?;
        let source: Value = serde_yaml_ng::from_slice(&std::fs::read(
            self.cluster_kubeconfig_path(id)?,
        )?)
        .map_err(|_| {
            IpcError::new(
                ErrorCode::Internal,
                "the cluster's kubeconfig cannot be read",
            )
        })?;
        let cluster = source.pointer("/clusters/0/cluster").ok_or_else(|| {
            IpcError::new(
                ErrorCode::Internal,
                "the cluster's kubeconfig has no cluster",
            )
        })?;
        let cluster = portable_cluster(cluster, |path| std::fs::read(path))?;

        let accounts: Api<ServiceAccount> = Api::namespaced(client, namespace);
        let request = TokenRequest {
            spec: Some(TokenRequestSpec {
                expiration_seconds: Some(expiration_seconds.unwrap_or(DEFAULT_LIFETIME_SECONDS)),
                ..TokenRequestSpec::default()
            }),
            ..TokenRequest::default()
        };
        let answer = accounts
            .create_token_request(name, &PostParams::default(), &request)
            .await?;
        let status = answer.status.ok_or_else(no_token)?;
        let token = status
            .token
            .filter(|token| !token.is_empty())
            .ok_or_else(no_token)?;
        let expires_at = status.expiration_timestamp.ok_or_else(no_token)?;
        let document = kubeconfig_document(cluster, namespace, name, &token);
        let text = serde_yaml_ng::to_string(&document)
            .map_err(|_| IpcError::new(ErrorCode::Internal, "the kubeconfig cannot be written"))?;
        write_private(dest, text.as_bytes()).map_err(|error| {
            // The io error quotes the destination path, which must not reach the caller.
            IpcError::new(
                error.code,
                "the kubeconfig cannot be written to the destination",
            )
        })?;
        Ok(SavedKubeconfig {
            expires_at: expires_at.0.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_connection_fields_are_kept() {
        let cluster = json!({
            "server": "https://s",
            "proxy-url": "http://p",
            "tls-server-name": "n",
            "insecure-skip-tls-verify": true,
            "extensions": [{ "name": "x" }],
        });
        let kept = portable_cluster(&cluster, |_| unreachable!()).unwrap();
        assert_eq!(
            kept,
            json!({
                "server": "https://s",
                "proxy-url": "http://p",
                "tls-server-name": "n",
                "insecure-skip-tls-verify": true,
            })
        );
    }

    #[test]
    fn a_ca_file_becomes_data_and_data_stays_as_it_is() {
        let from_file = json!({ "server": "s", "certificate-authority": "/ca.crt" });
        let kept = portable_cluster(&from_file, |path| {
            assert_eq!(path, "/ca.crt");
            Ok(b"ca".to_vec())
        })
        .unwrap();
        assert_eq!(kept["certificate-authority-data"], STANDARD.encode(b"ca"));
        assert!(kept.get("certificate-authority").is_none());

        let with_data = json!({ "server": "s", "certificate-authority-data": "abc" });
        let kept = portable_cluster(&with_data, |_| unreachable!()).unwrap();
        assert_eq!(kept["certificate-authority-data"], "abc");
    }

    #[test]
    fn a_ca_file_that_cannot_be_read_does_not_quote_its_path() {
        let cluster = json!({ "server": "s", "certificate-authority": "/secret/ca.crt" });
        let error = portable_cluster(&cluster, |_| Err(std::io::Error::other("nope"))).unwrap_err();
        assert!(!error.message.contains("secret"), "{}", error.message);
    }

    #[test]
    fn the_document_is_a_complete_kubeconfig() {
        let document = kubeconfig_document(json!({ "server": "s" }), "ns", "sa", "tok");
        assert_eq!(document["current-context"], "sa@ns");
        assert_eq!(document["users"][0]["user"]["token"], "tok");
        assert_eq!(document["contexts"][0]["context"]["namespace"], "ns");
        assert_eq!(document["clusters"][0]["cluster"]["server"], "s");
    }

    #[test]
    fn a_relative_or_homeless_destination_is_refused() {
        assert!(check_destination(Path::new("config")).is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(check_destination(&dir.path().join("missing").join("config")).is_err());
        assert!(check_destination(&dir.path().join("config")).is_ok());
    }
}
