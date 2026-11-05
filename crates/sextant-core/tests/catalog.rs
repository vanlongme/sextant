//! `AppCore` catalog, settings, hotbar and preferences against real files in
//! temp dirs. No test reads the process's `KUBECONFIG` or the developer's home.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sextant_core::app_core::{AppCore, CoreEvent};
use sextant_core::catalog::{ClusterEntry, ClusterSource};
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::{parse_contexts, SyncSource};
use sextant_core::paths::AppPaths;
use sextant_core::prefs::{ClusterSettings, Theme};
use tempfile::TempDir;

const LIMIT: Duration = Duration::from_secs(3);

/// A valid kubeconfig with one context per name.
fn config_with(names: &[&str]) -> String {
    let contexts: String = names
        .iter()
        .map(|n| format!("- {{ name: {n}, context: {{ cluster: c1, user: u1 }} }}\n"))
        .collect();
    format!(
        "apiVersion: v1\nkind: Config\n\
         clusters:\n- {{ name: c1, cluster: {{ server: \"https://x\" }} }}\n\
         users:\n- {{ name: u1, user: {{ token: t }} }}\n\
         contexts:\n{contexts}"
    )
}

struct Fixture {
    _root: TempDir,
    home: TempDir,
    paths: AppPaths,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(root.path(), home.path());
        Self {
            _root: root,
            home,
            paths,
        }
    }

    /// `<home>/.kube/config` holding one context per name.
    fn with_kube_config(names: &[&str]) -> Self {
        let fixture = Self::new();
        std::fs::create_dir_all(fixture.kube_config().parent().unwrap()).unwrap();
        std::fs::write(fixture.kube_config(), config_with(names)).unwrap();
        fixture
    }

    fn kube_config(&self) -> PathBuf {
        self.home.path().join(".kube").join("config")
    }

    fn pasted_dir(&self) -> PathBuf {
        self.paths.data.join("kubeconfigs")
    }

    fn pasted_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(self.pasted_dir())
            .unwrap()
            .map(|item| item.unwrap().path())
            .collect();
        files.sort();
        files
    }

    async fn start(&self) -> AppCore {
        AppCore::start_with_kubeconfig_env(self.paths.clone(), None)
            .await
            .unwrap()
    }
}

async fn wait_for_catalog(core: &AppCore, pred: impl Fn(&[ClusterEntry]) -> bool) {
    let waited = tokio::time::timeout(LIMIT, async {
        while !pred(&core.catalog_list()) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(
        waited.is_ok(),
        "condition not met within {LIMIT:?}; catalog: {:?}",
        core.catalog_list()
    );
}

async fn wait_for_names(core: &AppCore, expected: &[&str]) {
    wait_for_catalog(core, |entries| {
        let mut names: Vec<&str> = entries.iter().map(|e| e.context_name.as_str()).collect();
        names.sort_unstable();
        names == expected
    })
    .await;
}

fn id_of(core: &AppCore, context: &str) -> String {
    core.catalog_list()
        .into_iter()
        .find(|e| e.context_name == context)
        .unwrap_or_else(|| panic!("no entry for {context}"))
        .id
}

fn file_source(path: &Path) -> SyncSource {
    SyncSource::File(path.display().to_string())
}

#[tokio::test]
async fn default_source_lists_contexts_from_kube_dir() {
    let fixture = Fixture::with_kube_config(&["alpha", "beta"]);
    let core = fixture.start().await;

    wait_for_names(&core, &["alpha", "beta"]).await;

    let path = fixture.kube_config().display().to_string();
    for entry in core.catalog_list() {
        assert_eq!(entry.name, entry.context_name);
        assert_eq!(entry.source, ClusterSource::Synced { path: path.clone() });
        assert_eq!(entry.server.as_deref(), Some("https://x"));
        assert_eq!(entry.problem, None);
        assert_eq!(
            entry.state,
            sextant_core::cluster::ConnectionState::Disconnected
        );
    }
    core.shutdown().await;
}

#[tokio::test]
async fn display_name_overrides_name_and_persists() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let id = id_of(&core, "alpha");

    let settings = ClusterSettings {
        display_name: Some("Production".to_owned()),
        ..ClusterSettings::default()
    };
    core.cluster_settings_set(&id, settings.clone()).unwrap();

    assert_eq!(core.catalog_list()[0].name, "Production");
    assert_eq!(core.catalog_list()[0].context_name, "alpha");
    core.shutdown().await;

    let restarted = fixture.start().await;
    wait_for_names(&restarted, &["alpha"]).await;
    assert_eq!(restarted.catalog_list()[0].name, "Production");
    assert_eq!(restarted.cluster_settings_get(&id), settings);
    restarted.shutdown().await;
}

#[tokio::test]
async fn blank_display_name_falls_back_to_the_context_name() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let id = id_of(&core, "alpha");

    let settings = ClusterSettings {
        display_name: Some("  ".to_owned()),
        ..ClusterSettings::default()
    };
    core.cluster_settings_set(&id, settings).unwrap();

    assert_eq!(core.catalog_list()[0].name, "alpha");
    core.shutdown().await;
}

#[tokio::test]
async fn cluster_icon_setting_reaches_the_entry() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let id = id_of(&core, "alpha");
    assert_eq!(core.catalog_list()[0].icon, None);

    let settings = ClusterSettings {
        icon: Some("data:image/png;base64,AA==".to_owned()),
        ..ClusterSettings::default()
    };
    core.cluster_settings_set(&id, settings).unwrap();

    assert_eq!(
        core.catalog_list()[0].icon.as_deref(),
        Some("data:image/png;base64,AA==")
    );
    core.shutdown().await;
}

#[tokio::test]
async fn pasted_kubeconfig_is_added_private_and_idempotent() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    let yaml = config_with(&["one", "two"]);

    let first = core.catalog_add_pasted(&yaml).unwrap();
    let second = core.catalog_add_pasted(&yaml).unwrap();

    assert_eq!(first.len(), 2);
    assert_eq!(first, second);
    wait_for_names(&core, &["one", "two"]).await;

    let files = fixture.pasted_files();
    assert_eq!(files.len(), 1, "{files:?}");
    let name = files[0].file_name().unwrap().to_string_lossy().into_owned();
    let stem = name.strip_suffix(".yaml").unwrap();
    assert_eq!(stem.len(), 16, "{name}");
    assert!(stem.chars().all(|c| c.is_ascii_hexdigit()), "{name}");

    let path = files[0].display().to_string();
    for entry in core.catalog_list() {
        assert!(first.contains(&entry.id));
        assert_eq!(entry.source, ClusterSource::Pasted { path: path.clone() });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&files[0]).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir_mode = std::fs::metadata(fixture.pasted_dir())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(dir_mode & 0o777, 0o700);
    }

    assert!(
        core.prefs_get().sync_sources.iter().all(
            |source| !matches!(source, SyncSource::Dir(p) if Path::new(p) == fixture.pasted_dir())
        ),
        "the pasted directory stays out of the user's sources"
    );
    core.shutdown().await;
}

#[tokio::test]
async fn pasted_invalid_or_empty_is_rejected() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;

    for yaml in ["x: [", "", "contexts: []\n", "kind: Config\n"] {
        let err = core.catalog_add_pasted(yaml).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{yaml:?}");
    }

    assert!(fixture.pasted_files().is_empty());
    assert_eq!(core.catalog_list().len(), 1);
    core.shutdown().await;
}

#[tokio::test]
async fn pasted_errors_do_not_quote_values() {
    let fixture = Fixture::new();
    let core = fixture.start().await;

    for yaml in [
        "users: tok-SECRET",
        "kind: {tok-SECRET: 1, tok-SECRET: 2}\n",
    ] {
        let err = core.catalog_add_pasted(yaml).unwrap_err();

        assert_eq!(err.code, ErrorCode::InvalidInput, "{yaml:?}");
        let json = serde_json::to_string(&err).unwrap();
        assert!(!json.contains("tok-SECRET"), "{json}");
    }
    core.shutdown().await;
}

/// Two contexts whose names, clusters and users are given as `(context, cluster, user, token)`.
fn config_with_credentials(rows: &[(&str, &str, &str, &str)], current: &str) -> String {
    let mut clusters = String::new();
    let mut users = String::new();
    let mut contexts = String::new();
    for (context, cluster, user, token) in rows {
        let cluster_row =
            format!("- {{ name: {cluster}, cluster: {{ server: \"https://x\" }} }}\n");
        if !clusters.contains(&cluster_row) {
            clusters.push_str(&cluster_row);
        }
        let user_row = format!("- {{ name: {user}, user: {{ token: {token} }} }}\n");
        if !users.contains(&user_row) {
            users.push_str(&user_row);
        }
        contexts.push_str(&format!(
            "- {{ name: {context}, context: {{ cluster: {cluster}, user: {user} }} }}\n"
        ));
    }
    format!(
        "apiVersion: v1\nkind: Config\nclusters:\n{clusters}users:\n{users}\
         contexts:\n{contexts}current-context: {current}\n"
    )
}

/// The file behind a pasted context, as the catalog reports it.
async fn pasted_entry(core: &AppCore, context: &str) -> (String, PathBuf) {
    wait_for_catalog(core, |entries| {
        entries.iter().any(|e| e.context_name == context)
    })
    .await;
    let entries = core.catalog_list();
    let entry = entries.iter().find(|e| e.context_name == context).unwrap();
    match &entry.source {
        ClusterSource::Pasted { path } => (entry.id.clone(), PathBuf::from(path)),
        other => panic!("{context} is not pasted: {other:?}"),
    }
}

fn names_in(document: &serde_yaml_ng::Value, section: &str) -> Vec<String> {
    document[section]
        .as_sequence()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn removing_pasted_context_removes_its_credentials_from_disk() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    let yaml = config_with_credentials(
        &[
            ("one", "c1", "u1", "TOKEN-ONE"),
            ("two", "c2", "u2", "TOKEN-TWO"),
        ],
        "one",
    );
    core.catalog_add_pasted(&yaml).unwrap();
    let (id, path) = pasted_entry(&core, "one").await;

    core.catalog_remove_pasted(&id).unwrap();

    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("TOKEN-ONE"), "{text}");
    assert!(text.contains("TOKEN-TWO"), "{text}");
    let document: serde_yaml_ng::Value = serde_yaml_ng::from_str(&text).unwrap();
    assert_eq!(names_in(&document, "users"), ["u2"]);
    assert_eq!(names_in(&document, "clusters"), ["c2"]);
    assert_eq!(names_in(&document, "contexts"), ["two"]);
    assert_ne!(
        document.get("current-context").and_then(|c| c.as_str()),
        Some("one")
    );
    core.shutdown().await;
}

#[tokio::test]
async fn removing_pasted_context_keeps_entries_still_referenced() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    let yaml = config_with_credentials(
        &[
            ("one", "c1", "u1", "TOKEN-SHARED"),
            ("two", "c1", "u1", "TOKEN-SHARED"),
        ],
        "two",
    );
    core.catalog_add_pasted(&yaml).unwrap();
    let (id, path) = pasted_entry(&core, "one").await;

    core.catalog_remove_pasted(&id).unwrap();

    let bytes = std::fs::read(&path).unwrap();
    let document: serde_yaml_ng::Value = serde_yaml_ng::from_slice(&bytes).unwrap();
    assert_eq!(names_in(&document, "users"), ["u1"]);
    assert_eq!(names_in(&document, "clusters"), ["c1"]);
    assert_eq!(
        document.get("current-context").and_then(|c| c.as_str()),
        Some("two")
    );
    let left = parse_contexts(&path, &bytes).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].context_name, "two");
    assert_eq!(left[0].cluster_name, "c1");
    assert_eq!(left[0].user_name, "u1");
    assert!(left[0].problem.is_none(), "{:?}", left[0].problem);
    core.shutdown().await;
}

#[tokio::test]
async fn oversized_paste_is_rejected_rather_than_skipped_by_the_sync() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    let yaml = format!(
        "{}# {}\n",
        config_with(&["one"]),
        "x".repeat(10 * 1024 * 1024)
    );

    let err = core.catalog_add_pasted(&yaml).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(fixture.pasted_files().is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn remove_pasted_removes_only_that_context() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    let ids = core
        .catalog_add_pasted(&config_with(&["one", "two"]))
        .unwrap();
    wait_for_names(&core, &["one", "two"]).await;
    let (one, two) = (id_of(&core, "one"), id_of(&core, "two"));
    assert!(ids.contains(&one) && ids.contains(&two));

    core.catalog_remove_pasted(&one).unwrap();

    wait_for_names(&core, &["two"]).await;
    assert_eq!(id_of(&core, "two"), two, "the remaining id is stable");
    let files = fixture.pasted_files();
    assert_eq!(files.len(), 1);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&files[0]).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "a rewrite stays private");
    }

    core.catalog_remove_pasted(&two).unwrap();

    wait_for_names(&core, &[]).await;
    assert!(
        fixture.pasted_files().is_empty(),
        "removing the last deletes"
    );
    core.shutdown().await;
}

#[tokio::test]
async fn remove_right_after_paste_does_not_wait_for_the_sync() {
    let fixture = Fixture::new();
    let core = fixture.start().await;

    let ids = core.catalog_add_pasted(&config_with(&["one"])).unwrap();
    core.catalog_remove_pasted(&ids[0]).unwrap();

    assert!(fixture.pasted_files().is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn removing_twice_reports_not_found_while_the_entry_is_still_listed() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    core.catalog_add_pasted(&config_with(&["one"])).unwrap();
    wait_for_names(&core, &["one"]).await;
    let id = id_of(&core, "one");

    core.catalog_remove_pasted(&id).unwrap();
    let err = core.catalog_remove_pasted(&id).unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
    core.shutdown().await;
}

#[tokio::test]
async fn remove_pasted_refuses_synced_entries() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let before = std::fs::read(fixture.kube_config()).unwrap();
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let id = id_of(&core, "alpha");

    let err = core.catalog_remove_pasted(&id).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(std::fs::read(fixture.kube_config()).unwrap(), before);
    assert_eq!(core.catalog_list().len(), 1);
    core.shutdown().await;
}

#[tokio::test]
async fn remove_pasted_reports_an_unknown_id() {
    let fixture = Fixture::new();
    let core = fixture.start().await;

    let err = core.catalog_remove_pasted(&"f".repeat(32)).unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
    core.shutdown().await;
}

#[tokio::test]
async fn hotbar_drops_unknown_ids_on_read_but_keeps_order() {
    let fixture = Fixture::with_kube_config(&["a", "b"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["a", "b"]).await;
    let (a, b) = (id_of(&core, "a"), id_of(&core, "b"));

    core.hotbar_set(vec![b.clone(), "unknown".to_owned(), a.clone()])
        .unwrap();

    assert_eq!(core.hotbar_get(), vec![b.clone(), a.clone()]);
    core.shutdown().await;

    let restarted = fixture.start().await;
    wait_for_names(&restarted, &["a", "b"]).await;
    assert_eq!(restarted.hotbar_get(), vec![b, a], "order persists");
    restarted.shutdown().await;
}

#[tokio::test]
async fn hotbar_set_keeps_pins_the_catalog_does_not_list() {
    let fixture = Fixture::with_kube_config(&["a", "b"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["a", "b"]).await;
    let (a, b) = (id_of(&core, "a"), id_of(&core, "b"));

    core.hotbar_set(vec![a.clone(), "ghost".to_owned(), b.clone()])
        .unwrap();
    // The UI only sees listed pins, so it sends back a reordered visible list.
    core.hotbar_set(vec![b.clone(), a.clone()]).unwrap();

    assert_eq!(core.hotbar_get(), vec![b.clone(), a.clone()]);
    let stored = std::fs::read_to_string(fixture.paths.data.join("hotbar.json"))
        .or_else(|_| std::fs::read_to_string(fixture.paths.config.join("hotbar.json")))
        .unwrap();
    assert!(stored.contains("ghost"), "hidden pin survives: {stored}");
    core.shutdown().await;
}

#[tokio::test]
async fn prefs_set_sources_takes_effect() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let outside = tempfile::tempdir().unwrap();
    let extra = outside.path().join("extra.yaml");
    std::fs::write(&extra, config_with(&["extra"])).unwrap();

    let original = core.prefs_get();
    let mut added = original.clone();
    added.sync_sources.push(file_source(&extra));
    added.theme = Theme::Dark;
    core.prefs_set(added.clone()).unwrap();

    wait_for_names(&core, &["alpha", "extra"]).await;
    assert_eq!(core.prefs_get(), added);

    core.prefs_set(original.clone()).unwrap();

    wait_for_names(&core, &["alpha"]).await;
    assert_eq!(core.prefs_get(), original);
    core.shutdown().await;
}

#[tokio::test]
async fn prefs_set_rejects_relative_sources() {
    let fixture = Fixture::new();
    let core = fixture.start().await;
    let original = core.prefs_get();
    let mut relative = original.clone();
    relative
        .sync_sources
        .push(SyncSource::File("configs/dev.yaml".to_owned()));

    let err = core.prefs_set(relative).unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(core.prefs_get(), original);
    core.shutdown().await;
}

#[tokio::test]
async fn subscribe_gets_catalog_changed_on_file_change() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let mut events = core.subscribe();

    std::fs::write(fixture.kube_config(), config_with(&["alpha", "added"])).unwrap();

    // An event from the first scan may still be queued, so only one that comes
    // with the new context in the catalog counts.
    let received = tokio::time::timeout(LIMIT, async {
        loop {
            let event = events.recv().await.unwrap();
            let has_new = core
                .catalog_list()
                .iter()
                .any(|e| e.context_name == "added");
            if matches!(event, CoreEvent::CatalogChanged) && has_new {
                return;
            }
        }
    })
    .await;
    assert!(received.is_ok(), "no CatalogChanged within {LIMIT:?}");
    core.shutdown().await;
}

#[tokio::test]
async fn subscribe_gets_catalog_changed_on_display_name_change() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let id = id_of(&core, "alpha");
    let mut events = core.subscribe();

    let settings = ClusterSettings {
        display_name: Some("Renamed".to_owned()),
        ..ClusterSettings::default()
    };
    core.cluster_settings_set(&id, settings).unwrap();

    let received = tokio::time::timeout(LIMIT, async {
        loop {
            let event = events.recv().await.unwrap();
            if matches!(event, CoreEvent::CatalogChanged)
                && core.catalog_list()[0].name == "Renamed"
            {
                return;
            }
        }
    })
    .await;
    assert!(received.is_ok(), "no CatalogChanged within {LIMIT:?}");
    core.shutdown().await;
}

#[tokio::test]
async fn subscribe_gets_kubeconfig_warnings() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let mut events = core.subscribe();

    std::fs::write(fixture.kube_config(), "x: [").unwrap();

    let path = fixture.kube_config().display().to_string();
    let received = tokio::time::timeout(LIMIT, async {
        loop {
            if let CoreEvent::KubeconfigWarnings { warnings } = events.recv().await.unwrap() {
                return warnings;
            }
        }
    })
    .await
    .expect("no KubeconfigWarnings in time");
    assert_eq!(received.len(), 1, "{received:?}");
    assert_eq!(received[0].path, path);
    assert_eq!(core.catalog_warnings(), received);
    assert_eq!(core.catalog_list().len(), 1, "previous entries are kept");
    core.shutdown().await;
}

#[tokio::test]
async fn app_starts_with_corrupt_stores_and_reports_warnings() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    std::fs::create_dir_all(&fixture.paths.config).unwrap();
    std::fs::write(fixture.paths.config.join("prefs.json"), "{ garbage").unwrap();
    std::fs::write(fixture.paths.config.join("clusters.json"), "not json").unwrap();

    let core = fixture.start().await;

    let warnings = core.take_startup_warnings();
    let mut files: Vec<&str> = warnings.iter().map(|w| w.file.as_str()).collect();
    files.sort_unstable();
    assert_eq!(files, ["clusters.json", "prefs.json"]);
    assert!(core.take_startup_warnings().is_empty(), "delivered once");

    // A corrupt prefs file counts as a first run, so the catalog is not empty.
    wait_for_names(&core, &["alpha"]).await;
    core.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn startup_keeps_a_prefs_file_it_could_not_read() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let config = &fixture.paths.config;
    std::fs::create_dir_all(config).unwrap();
    let prefs = config.join("prefs.json");
    let saved = r#"{"version":1,"data":{"theme":"dark","syncSources":[{"kind":"file","path":"/custom/saved.yaml"}]}}"#;
    std::fs::write(&prefs, saved).unwrap();
    std::fs::set_permissions(&prefs, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read(&prefs).is_ok() {
        eprintln!("skipped: root ignores file modes");
        return;
    }

    let core = fixture.start().await;

    let warnings = core.take_startup_warnings();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert_eq!(warnings[0].file, "prefs.json");
    // The file cannot be used, so this is a first run, but the saved sources survive it.
    wait_for_names(&core, &["alpha"]).await;
    core.shutdown().await;
    let kept = std::fs::read_dir(config)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|path| path.to_string_lossy().contains("prefs.json.unreadable-"))
        .expect("the unread file is kept beside the new one");
    std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(std::fs::read_to_string(kept).unwrap(), saved);
}

#[cfg(unix)]
#[tokio::test]
async fn startup_does_not_seed_over_a_prefs_file_it_could_not_move() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let config = &fixture.paths.config;
    std::fs::create_dir_all(config).unwrap();
    let prefs = config.join("prefs.json");
    std::fs::write(&prefs, "{ garbage").unwrap();
    std::fs::set_permissions(config, std::fs::Permissions::from_mode(0o500)).unwrap();
    if std::fs::write(config.join("probe"), "").is_ok() {
        eprintln!("skipped: root ignores directory modes");
        return;
    }

    let core = fixture.start().await;

    let warnings = core.take_startup_warnings();
    std::fs::set_permissions(config, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(warnings.len(), 1, "no seed write was tried: {warnings:?}");
    assert!(
        warnings[0].message.contains("could not be moved aside"),
        "{warnings:?}"
    );
    assert_eq!(std::fs::read_to_string(&prefs).unwrap(), "{ garbage");
    // The defaults still apply for this session.
    wait_for_names(&core, &["alpha"]).await;
    core.shutdown().await;
}

#[tokio::test]
async fn first_run_seeds_sources_from_env_only_once() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let outside = tempfile::tempdir().unwrap();
    let from_env = outside.path().join("env.yaml");
    std::fs::write(&from_env, config_with(&["from-env"])).unwrap();
    let env = OsString::from(from_env.as_os_str());

    let core = AppCore::start_with_kubeconfig_env(fixture.paths.clone(), Some(env))
        .await
        .unwrap();
    wait_for_names(&core, &["alpha", "from-env"]).await;
    let seeded = core.prefs_get().sync_sources;
    assert_eq!(seeded.len(), 2);
    assert_eq!(seeded[1], file_source(&from_env));
    core.shutdown().await;

    let other = OsString::from(outside.path().join("other.yaml").as_os_str());
    let restarted = AppCore::start_with_kubeconfig_env(fixture.paths.clone(), Some(other))
        .await
        .unwrap();
    assert_eq!(restarted.prefs_get().sync_sources, seeded);
    restarted.shutdown().await;
}

#[tokio::test]
async fn a_saved_empty_source_list_is_respected() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    wait_for_names(&core, &["alpha"]).await;
    let mut prefs = core.prefs_get();
    prefs.sync_sources.clear();
    core.prefs_set(prefs).unwrap();
    wait_for_names(&core, &[]).await;
    core.shutdown().await;

    let restarted = fixture.start().await;

    assert!(restarted.prefs_get().sync_sources.is_empty());
    // Give a wrongly reseeded source the time to show up.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(restarted.catalog_list().is_empty());
    restarted.shutdown().await;
}

#[tokio::test]
async fn app_core_is_cloneable_and_shutdown_is_repeatable() {
    let fixture = Fixture::with_kube_config(&["alpha"]);
    let core = fixture.start().await;
    let clone = core.clone();
    wait_for_names(&clone, &["alpha"]).await;

    core.shutdown().await;
    clone.shutdown().await;

    assert_eq!(
        clone.catalog_list().len(),
        1,
        "the last snapshot stays readable"
    );
}
