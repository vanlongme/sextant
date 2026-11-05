//! What must not cross into the webview with a listed or watched object.

use serde_json::Value;

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Removes `metadata.managedFields` and the last-applied annotation, which can
/// quote a Secret's values, and blanks a core `v1` Secret's values. Its keys stay,
/// so the UI can count them. An object must carry `kind` and `apiVersion` for its
/// values to be recognized, and list items from an API server do not.
pub fn strip_for_list(obj: &mut Value) {
    if let Some(metadata) = obj.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.remove("managedFields");
        if let Some(annotations) = metadata
            .get_mut("annotations")
            .and_then(Value::as_object_mut)
        {
            annotations.remove(LAST_APPLIED);
        }
    }
    let is_secret = obj.get("kind").and_then(Value::as_str) == Some("Secret")
        && obj.get("apiVersion").and_then(Value::as_str) == Some("v1");
    if !is_secret {
        return;
    }
    for field in ["data", "stringData"] {
        if let Some(values) = obj.get_mut(field).and_then(Value::as_object_mut) {
            for value in values.values_mut() {
                *value = Value::String(String::new());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn removes_managed_fields_and_the_last_applied_annotation() {
        let mut obj = json!({
            "kind": "Pod",
            "apiVersion": "v1",
            "metadata": {
                "name": "p",
                "managedFields": [{ "manager": "m" }],
                "annotations": { LAST_APPLIED: "{}", "keep": "me" },
            },
        });

        strip_for_list(&mut obj);

        assert_eq!(
            obj["metadata"],
            json!({ "name": "p", "annotations": { "keep": "me" } })
        );
    }

    #[test]
    fn blanks_secret_values_and_keeps_keys() {
        let mut obj = json!({
            "kind": "Secret",
            "apiVersion": "v1",
            "metadata": { "name": "s" },
            "type": "Opaque",
            "data": { "a": "czNjcjN0", "b": "czNjcjN0" },
            "stringData": { "c": "plain" },
        });

        strip_for_list(&mut obj);

        assert_eq!(obj["data"], json!({ "a": "", "b": "" }));
        assert_eq!(obj["stringData"], json!({ "c": "" }));
        assert_eq!(obj["type"], "Opaque");
    }

    #[test]
    fn leaves_the_data_of_other_kinds() {
        let mut map = json!({ "kind": "ConfigMap", "apiVersion": "v1", "data": { "a": "1" } });
        let mut custom = json!({
            "kind": "Secret",
            "apiVersion": "example.com/v1",
            "data": { "a": "1" },
        });

        strip_for_list(&mut map);
        strip_for_list(&mut custom);

        assert_eq!(map["data"]["a"], "1");
        assert_eq!(custom["data"]["a"], "1");
    }

    #[test]
    fn tolerates_unexpected_shapes() {
        for mut obj in [
            json!(null),
            json!("text"),
            json!({ "metadata": "text" }),
            json!({ "metadata": { "annotations": 1 } }),
            json!({ "kind": "Secret", "apiVersion": "v1", "data": "text" }),
        ] {
            let before = obj.clone();
            strip_for_list(&mut obj);
            assert_eq!(obj, before);
        }
    }
}
