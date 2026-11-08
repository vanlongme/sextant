//! Where an Application's AppProject lives, and whether the project has sync windows.
//! SkoposIDE does not evaluate windows, because a wrong answer in either direction is worse
//! than asking the user.

use serde_json::Value;

/// The namespace and name of the Application's AppProject. The project is `spec.project`, or
/// `default` when that is empty. It lives where the controller runs, which the controller
/// records in `status.controllerNamespace`, or else beside the Application.
pub(super) fn project_location(app: &Value) -> (String, String) {
    let text = |pointer: &str| {
        app.pointer(pointer)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };
    let name = text("/spec/project").unwrap_or("default");
    let namespace = text("/status/controllerNamespace")
        .or_else(|| text("/metadata/namespace"))
        .unwrap_or_default();
    (namespace.to_owned(), name.to_owned())
}

pub(super) fn has_sync_windows(project: &Value) -> bool {
    project
        .pointer("/spec/syncWindows")
        .and_then(Value::as_array)
        .is_some_and(|windows| !windows.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_project_is_default_when_unnamed_and_lives_where_the_controller_runs() {
        let unnamed = json!({ "metadata": { "namespace": "team-a" }, "spec": { "project": "" } });
        assert_eq!(
            project_location(&unnamed),
            ("team-a".to_owned(), "default".to_owned())
        );
        let recorded = json!({
            "metadata": { "namespace": "team-a" },
            "spec": { "project": "web" },
            "status": { "controllerNamespace": "argocd" },
        });
        assert_eq!(
            project_location(&recorded),
            ("argocd".to_owned(), "web".to_owned())
        );
        assert_eq!(
            project_location(&json!({})),
            (String::new(), "default".to_owned())
        );
    }

    #[test]
    fn only_a_project_with_windows_has_them() {
        assert!(!has_sync_windows(&json!({ "spec": {} })));
        assert!(!has_sync_windows(&json!({ "spec": { "syncWindows": [] } })));
        assert!(!has_sync_windows(
            &json!({ "spec": { "syncWindows": null } })
        ));
        assert!(has_sync_windows(
            &json!({ "spec": { "syncWindows": [{ "kind": "deny" }] } })
        ));
    }
}
