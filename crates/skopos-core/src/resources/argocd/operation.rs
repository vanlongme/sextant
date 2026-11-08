//! What an Argo CD action writes into an Application, decided from the Application as read.
//! It is pure, so each rule is tested without a cluster.

use serde_json::{json, Map, Value};

use super::{ArgoSyncOptions, ArgoSyncStrategy};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::resources::invalid;

/// The name the history and the controller's logs give for who started an operation.
pub(super) const USERNAME: &str = "skopos";

pub(super) fn is_deleting(app: &Value) -> bool {
    app.pointer("/metadata/deletionTimestamp")
        .is_some_and(|stamp| !stamp.is_null())
}

pub(super) fn refuse_if_deleting(app: &Value, name: &str) -> CoreResult<()> {
    if is_deleting(app) {
        return Err(invalid(format!("{name} is being deleted")));
    }
    Ok(())
}

/// The controller removes `operation` when an operation ends, so one that is set is running
/// or about to start.
pub(super) fn refuse_if_running(app: &Value, name: &str) -> CoreResult<()> {
    if app
        .get("operation")
        .is_some_and(|operation| !operation.is_null())
    {
        return Err(IpcError::new(
            ErrorCode::Conflict,
            format!("another operation is already in progress on {name}"),
        ));
    }
    Ok(())
}

/// Auto-sync is on when `spec.syncPolicy.automated` is present and its `enabled` is not
/// `false`, so an empty `automated: {}` counts as on.
pub(super) fn auto_sync_enabled(app: &Value) -> bool {
    match app.pointer("/spec/syncPolicy/automated") {
        Some(Value::Object(automated)) => automated.get("enabled") != Some(&Value::Bool(false)),
        _ => false,
    }
}

fn several_sources(app: &Value) -> bool {
    app.pointer("/spec/sources")
        .and_then(Value::as_array)
        .is_some_and(|sources| !sources.is_empty())
}

/// The sync options an operation carries: the ones asked for, or else the Application's own.
pub(super) fn sync_options(app: &Value, asked: &[String]) -> Option<Value> {
    if !asked.is_empty() {
        return Some(json!(asked));
    }
    app.pointer("/spec/syncPolicy/syncOptions")
        .filter(|own| own.as_array().is_some_and(|own| !own.is_empty()))
        .cloned()
}

/// Refuses a resource without a kind or a name, before anything is read.
pub(super) fn check_resources(options: &ArgoSyncOptions) -> CoreResult<()> {
    for resource in options.resources.iter().flatten() {
        if resource.kind.trim().is_empty() || resource.name.trim().is_empty() {
            return Err(invalid("each resource to sync needs a kind and a name"));
        }
    }
    Ok(())
}

/// The sync operation the Argo CD API server writes for these options. That server resolves
/// `targetRevision` to a commit through its repo server, which SkoposIDE cannot reach, so
/// `revision` is left out unless one is asked for, and the controller syncs to `targetRevision`.
pub(super) fn sync_operation(app: &Value, options: &ArgoSyncOptions) -> CoreResult<Value> {
    let revision = options
        .revision
        .as_deref()
        .map(str::trim)
        .filter(|revision| !revision.is_empty());
    let mut sync = Map::new();
    if several_sources(app) {
        if revision.is_some() {
            return Err(invalid(
                "a revision cannot be chosen for an Application with several sources",
            ));
        }
        sync.insert("sources".into(), app["spec"]["sources"].clone());
    } else {
        if let Some(source) = app
            .pointer("/spec/source")
            .filter(|source| source.is_object())
        {
            sync.insert("source".into(), source.clone());
        }
        if let Some(revision) = revision {
            let target = app
                .pointer("/spec/source/targetRevision")
                .and_then(Value::as_str)
                .filter(|target| !target.is_empty())
                .unwrap_or("HEAD");
            // Auto-sync would return to the target at once.
            if revision != target && auto_sync_enabled(app) && !options.dry_run {
                return Err(invalid(format!(
                    "cannot sync to {revision}: auto-sync is set to {target}"
                )));
            }
            sync.insert("revision".into(), revision.into());
        }
    }
    sync.insert("prune".into(), options.prune.into());
    sync.insert("dryRun".into(), options.dry_run.into());
    let strategy = match options.strategy {
        ArgoSyncStrategy::Hook => "hook",
        ArgoSyncStrategy::Apply => "apply",
    };
    let mut chosen = Map::new();
    chosen.insert(strategy.into(), json!({ "force": options.force }));
    sync.insert("syncStrategy".into(), Value::Object(chosen));
    if let Some(sync_options) = sync_options(app, &options.sync_options) {
        sync.insert("syncOptions".into(), sync_options);
    }
    let resources: Vec<Value> = options
        .resources
        .iter()
        .flatten()
        .map(|resource| {
            let mut entry = Map::new();
            entry.insert("group".into(), resource.group.clone().into());
            entry.insert("kind".into(), resource.kind.clone().into());
            entry.insert("name".into(), resource.name.clone().into());
            if let Some(namespace) = resource.namespace.as_deref().filter(|ns| !ns.is_empty()) {
                entry.insert("namespace".into(), namespace.into());
            }
            Value::Object(entry)
        })
        .collect();
    if !resources.is_empty() {
        sync.insert("resources".into(), resources.into());
    }
    let mut operation = Map::new();
    operation.insert("sync".into(), Value::Object(sync));
    operation.insert("initiatedBy".into(), json!({ "username": USERNAME }));
    if let Some(retry) = app
        .pointer("/spec/syncPolicy/retry")
        .filter(|retry| retry.is_object())
    {
        operation.insert("retry".into(), retry.clone());
    }
    Ok(Value::Object(operation))
}

/// The Application with `operation` set and `status.operationState` cleared. A stale state
/// that still reads as running would make the controller resume it instead of this one.
pub(super) fn with_operation(mut app: Value, operation: Value) -> CoreResult<Value> {
    let fields = app.as_object_mut().ok_or_else(not_an_object)?;
    fields.insert("operation".into(), operation);
    if let Some(status) = fields.get_mut("status").and_then(Value::as_object_mut) {
        status.remove("operationState");
    }
    Ok(app)
}

pub(super) fn not_an_object() -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        "the API server answered with something that is not an Application",
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::resources::ArgoSyncResource;

    fn application() -> Value {
        json!({
            "metadata": { "name": "guestbook", "namespace": "argocd" },
            "spec": {
                "source": {
                    "repoURL": "https://git.example.com/apps.git",
                    "path": "guestbook",
                    "targetRevision": "main",
                },
                "destination": { "server": "https://kubernetes.default.svc", "namespace": "guestbook" },
            },
        })
    }

    fn options() -> ArgoSyncOptions {
        ArgoSyncOptions {
            revision: None,
            prune: false,
            dry_run: false,
            force: false,
            strategy: ArgoSyncStrategy::Hook,
            sync_options: Vec::new(),
            resources: None,
            acknowledge_sync_windows: false,
        }
    }

    #[test]
    fn auto_sync_is_on_when_automated_is_present_and_not_disabled() {
        let with = |policy: Value| json!({ "spec": { "syncPolicy": policy } });
        assert!(!auto_sync_enabled(&application()));
        assert!(!auto_sync_enabled(&with(json!(null))));
        assert!(!auto_sync_enabled(&with(json!({ "automated": null }))));
        assert!(auto_sync_enabled(&with(json!({ "automated": {} }))));
        assert!(auto_sync_enabled(&with(
            json!({ "automated": { "enabled": true } })
        )));
        assert!(auto_sync_enabled(&with(
            json!({ "automated": { "enabled": null } })
        )));
        assert!(!auto_sync_enabled(&with(
            json!({ "automated": { "enabled": false } })
        )));
    }

    #[test]
    fn a_sync_of_one_source_copies_it_and_carries_the_options() {
        let mut app = application();
        app["spec"]["syncPolicy"] = json!({ "retry": { "limit": 2 } });
        let source = app["spec"]["source"].clone();
        let options = ArgoSyncOptions {
            revision: Some(" v2 ".into()),
            prune: true,
            dry_run: true,
            force: true,
            strategy: ArgoSyncStrategy::Apply,
            sync_options: vec!["Validate=false".into()],
            resources: Some(vec![
                ArgoSyncResource {
                    group: String::new(),
                    kind: "Service".into(),
                    namespace: None,
                    name: "web".into(),
                },
                ArgoSyncResource {
                    group: "apps".into(),
                    kind: "Deployment".into(),
                    namespace: Some("guestbook".into()),
                    name: "web".into(),
                },
            ]),
            acknowledge_sync_windows: false,
        };
        assert_eq!(
            sync_operation(&app, &options).unwrap(),
            json!({
                "sync": {
                    "source": source,
                    "revision": "v2",
                    "prune": true,
                    "dryRun": true,
                    "syncStrategy": { "apply": { "force": true } },
                    "syncOptions": ["Validate=false"],
                    "resources": [
                        { "group": "", "kind": "Service", "name": "web" },
                        { "group": "apps", "kind": "Deployment", "namespace": "guestbook", "name": "web" },
                    ],
                },
                "initiatedBy": { "username": "skopos" },
                "retry": { "limit": 2 },
            })
        );
    }

    #[test]
    fn without_a_revision_none_is_sent_and_the_controller_takes_the_target() {
        let blank = ArgoSyncOptions {
            revision: Some("  ".into()),
            ..options()
        };
        let operation = sync_operation(&application(), &blank).unwrap();
        assert!(operation.pointer("/sync/revision").is_none(), "{operation}");
        assert!(operation.get("retry").is_none(), "{operation}");
        assert!(
            operation.pointer("/sync/resources").is_none(),
            "{operation}"
        );
        assert!(
            operation.pointer("/sync/syncOptions").is_none(),
            "{operation}"
        );
        assert_eq!(
            operation["sync"]["syncStrategy"],
            json!({ "hook": { "force": false } })
        );
        assert!(operation.pointer("/initiatedBy/automated").is_none());
    }

    #[test]
    fn several_sources_are_copied_and_a_revision_for_them_is_refused() {
        let sources = json!([
            { "repoURL": "https://git.example.com/a.git" },
            { "repoURL": "https://git.example.com/b.git" },
        ]);
        let app = json!({ "spec": { "sources": sources } });
        let operation = sync_operation(&app, &options()).unwrap();
        assert_eq!(operation["sync"]["sources"], sources);
        assert!(operation.pointer("/sync/source").is_none(), "{operation}");
        let pinned = ArgoSyncOptions {
            revision: Some("v2".into()),
            ..options()
        };
        assert_eq!(
            sync_operation(&app, &pinned).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn another_revision_while_auto_sync_is_on_is_refused_unless_a_dry_run() {
        let mut app = application();
        app["spec"]["syncPolicy"] = json!({ "automated": {} });
        let other = ArgoSyncOptions {
            revision: Some("v2".into()),
            ..options()
        };
        assert_eq!(
            sync_operation(&app, &other).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        let dry_run = ArgoSyncOptions {
            dry_run: true,
            ..other.clone()
        };
        assert!(sync_operation(&app, &dry_run).is_ok());
        let same = ArgoSyncOptions {
            revision: Some("main".into()),
            ..options()
        };
        assert!(sync_operation(&app, &same).is_ok());
        // An empty target means HEAD.
        app["spec"]["source"]["targetRevision"] = json!("");
        let head = ArgoSyncOptions {
            revision: Some("HEAD".into()),
            ..options()
        };
        assert!(sync_operation(&app, &head).is_ok());
    }

    #[test]
    fn no_sync_options_asked_for_takes_the_applications_own() {
        let mut app = application();
        app["spec"]["syncPolicy"] = json!({ "syncOptions": ["CreateNamespace=true"] });
        let own = sync_operation(&app, &options()).unwrap();
        assert_eq!(own["sync"]["syncOptions"], json!(["CreateNamespace=true"]));
        let asked = ArgoSyncOptions {
            sync_options: vec!["Validate=false".into()],
            ..options()
        };
        let asked = sync_operation(&app, &asked).unwrap();
        assert_eq!(asked["sync"]["syncOptions"], json!(["Validate=false"]));
    }

    #[test]
    fn a_resource_without_a_kind_or_a_name_is_refused() {
        let one = |kind: &str, name: &str| ArgoSyncOptions {
            resources: Some(vec![ArgoSyncResource {
                group: "apps".into(),
                kind: kind.into(),
                namespace: None,
                name: name.into(),
            }]),
            ..options()
        };
        assert!(check_resources(&one("Deployment", "web")).is_ok());
        assert!(check_resources(&options()).is_ok());
        assert_eq!(
            check_resources(&one("", "web")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            check_resources(&one("Deployment", " ")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn an_operation_in_progress_or_a_deletion_is_refused() {
        assert!(refuse_if_running(&application(), "guestbook").is_ok());
        let mut running = application();
        running["operation"] = json!({ "sync": {} });
        assert_eq!(
            refuse_if_running(&running, "guestbook").unwrap_err().code,
            ErrorCode::Conflict
        );
        running["operation"] = Value::Null;
        assert!(refuse_if_running(&running, "guestbook").is_ok());

        assert!(refuse_if_deleting(&application(), "guestbook").is_ok());
        let mut deleting = application();
        deleting["metadata"]["deletionTimestamp"] = json!("2026-11-08T08:00:00Z");
        assert!(is_deleting(&deleting));
        assert_eq!(
            refuse_if_deleting(&deleting, "guestbook").unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn setting_the_operation_clears_the_old_state_and_keeps_the_rest_of_status() {
        let mut app = application();
        app["status"] = json!({
            "operationState": { "phase": "Running" },
            "sync": { "status": "OutOfSync" },
        });
        let written = with_operation(app, json!({ "sync": {} })).unwrap();
        assert_eq!(written["operation"], json!({ "sync": {} }));
        assert_eq!(
            written["status"],
            json!({ "sync": { "status": "OutOfSync" } })
        );
        assert_eq!(
            with_operation(json!("text"), json!({})).unwrap_err().code,
            ErrorCode::Internal
        );
    }
}
