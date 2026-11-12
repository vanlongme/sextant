//! ConfigMaps, Secrets, ServiceAccounts and PersistentVolumeClaims (spec E §4.6). A Secret's
//! values are never read: only its type and the number of its keys.

use serde_json::Value;

use super::{items, text, Item};
use crate::graph::types::GraphStatus;

fn key_count(object: &Value, pointer: &str) -> usize {
    object
        .pointer(pointer)
        .and_then(Value::as_object)
        .map_or(0, serde_json::Map::len)
}

pub(super) fn config_map(item: &mut Item, object: &Value) {
    let keys = key_count(object, "/data") + key_count(object, "/binaryData");
    item.fact("Keys", keys.to_string());
}

pub(super) fn secret(item: &mut Item, object: &Value) {
    item.fact_if("Type", text(object, "/type"));
    item.fact("Keys", key_count(object, "/data").to_string());
}

pub(super) fn service_account(item: &mut Item, object: &Value) {
    let automount = object
        .pointer("/automountServiceAccountToken")
        .and_then(Value::as_bool)
        != Some(false);
    item.fact("Automount token", if automount { "Yes" } else { "No" });
}

pub(super) fn claim(item: &mut Item, object: &Value) {
    let phase = text(object, "/status/phase");
    item.status = match phase.as_deref() {
        Some("Pending") => GraphStatus::Warning,
        Some("Lost") => GraphStatus::Critical,
        _ => GraphStatus::Neutral,
    };
    item.status_text.clone_from(&phase);
    item.fact_if("Status", phase);
    item.fact_if("Capacity", text(object, "/status/capacity/storage"));
    item.fact_if("Storage class", text(object, "/spec/storageClassName"));
    let modes: Vec<String> = items(object, "/spec/accessModes")
        .iter()
        .filter_map(|mode| mode.as_str().map(str::to_owned))
        .collect();
    if !modes.is_empty() {
        item.fact("Access modes", modes.join(", "));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::graph::extract::test_support::{facts, item};
    use crate::graph::kinds::Kind;
    use crate::graph::types::GraphStatus;

    #[test]
    fn a_config_map_counts_its_keys() {
        let map = item(
            Kind::ConfigMap,
            json!({
                "metadata": { "name": "c", "namespace": "a" },
                "data": { "a": "1", "b": "2" },
                "binaryData": { "c": "AA==" },
            }),
        );
        assert_eq!(map.status, GraphStatus::Neutral);
        assert_eq!(facts(&map), [("Keys", "3")]);
        let empty = item(
            Kind::ConfigMap,
            json!({ "metadata": { "name": "e", "namespace": "a" } }),
        );
        assert_eq!(facts(&empty), [("Keys", "0")]);
    }

    #[test]
    fn a_secret_shows_its_type_and_key_count_and_never_a_value() {
        let secret = item(
            Kind::Secret,
            json!({
                "metadata": { "name": "s", "namespace": "a" },
                "type": "kubernetes.io/tls",
                "data": { "tls.crt": "c2VjcmV0LXZhbHVl", "tls.key": "" },
            }),
        );
        assert_eq!(secret.status, GraphStatus::Neutral);
        assert_eq!(
            facts(&secret),
            [("Type", "kubernetes.io/tls"), ("Keys", "2")]
        );
        assert!(!format!("{secret:?}").contains("c2VjcmV0LXZhbHVl"));
    }

    #[test]
    fn a_service_account_says_whether_it_mounts_its_token() {
        let default = item(
            Kind::ServiceAccount,
            json!({ "metadata": { "name": "d", "namespace": "a" } }),
        );
        assert_eq!(facts(&default), [("Automount token", "Yes")]);
        let off = item(
            Kind::ServiceAccount,
            json!({ "metadata": { "name": "o", "namespace": "a" }, "automountServiceAccountToken": false }),
        );
        assert_eq!(facts(&off), [("Automount token", "No")]);
    }

    #[test]
    fn a_claim_reads_its_phase() {
        let claim = |phase: Option<&str>| {
            item(
                Kind::PersistentVolumeClaim,
                json!({
                    "metadata": { "name": "data", "namespace": "a" },
                    "spec": { "storageClassName": "standard", "accessModes": ["ReadWriteOnce", "ReadOnlyMany"] },
                    "status": { "phase": phase, "capacity": { "storage": "1Gi" } },
                }),
            )
        };
        let bound = claim(Some("Bound"));
        assert_eq!(
            (bound.status, bound.status_text.as_deref()),
            (GraphStatus::Neutral, Some("Bound"))
        );
        assert_eq!(
            facts(&bound),
            [
                ("Status", "Bound"),
                ("Capacity", "1Gi"),
                ("Storage class", "standard"),
                ("Access modes", "ReadWriteOnce, ReadOnlyMany"),
            ]
        );
        let pending = claim(Some("Pending"));
        assert_eq!(
            (pending.status, pending.status_text.as_deref()),
            (GraphStatus::Warning, Some("Pending"))
        );
        let lost = claim(Some("Lost"));
        assert_eq!(
            (lost.status, lost.status_text.as_deref()),
            (GraphStatus::Critical, Some("Lost"))
        );
        let unknown = claim(None);
        assert_eq!(
            (unknown.status, unknown.status_text.as_deref()),
            (GraphStatus::Neutral, None)
        );
    }
}
