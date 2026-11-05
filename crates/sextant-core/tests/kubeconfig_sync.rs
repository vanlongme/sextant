//! Behaviour of the kubeconfig sync watcher against real files in temp dirs.
//!
//! Tests that prove the notify path use `NO_POLL`, so a pass cannot come from
//! the polling safety net.

use std::path::Path;
use std::time::Duration;

use sextant_core::kubeconfig::{KubeconfigSync, SyncSnapshot, SyncSource};
use tokio::sync::watch::Receiver;

const NO_POLL: Duration = Duration::from_secs(3600);
const DEFAULT_LIMIT: Duration = Duration::from_secs(5);

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

fn dir_source(path: &Path) -> SyncSource {
    SyncSource::Dir(path.display().to_string())
}

fn file_source(path: &Path) -> SyncSource {
    SyncSource::File(path.display().to_string())
}

async fn wait_for_within(
    rx: &mut Receiver<SyncSnapshot>,
    limit: Duration,
    pred: impl FnMut(&SyncSnapshot) -> bool,
) -> SyncSnapshot {
    let outcome = tokio::time::timeout(limit, rx.wait_for(pred))
        .await
        .map(|waited| waited.map(|snapshot| snapshot.clone()));
    match outcome {
        Ok(Ok(snapshot)) => snapshot,
        Ok(Err(_)) => panic!("sync stopped while waiting"),
        Err(_) => panic!(
            "condition not met within {limit:?}; last snapshot: {:?}",
            *rx.borrow()
        ),
    }
}

async fn wait_for(
    rx: &mut Receiver<SyncSnapshot>,
    pred: impl FnMut(&SyncSnapshot) -> bool,
) -> SyncSnapshot {
    wait_for_within(rx, DEFAULT_LIMIT, pred).await
}

#[tokio::test]
async fn watcher_picks_up_new_file_within_2s() {
    let dir = tempfile::tempdir().unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    // Let the first scan and the watches settle so the write below is a change.
    tokio::time::sleep(Duration::from_millis(200)).await;

    std::fs::write(dir.path().join("config"), config_with(&["one"])).unwrap();

    let snapshot = wait_for_within(&mut rx, Duration::from_secs(2), |s| s.entries.len() == 1).await;
    assert_eq!(snapshot.entries[0].context_name, "one");
    sync.stop();
}

#[tokio::test]
async fn atomic_rename_replace_is_detected() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    std::fs::write(&config, config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    let tmp = dir.path().join("config.tmp");
    std::fs::write(&tmp, config_with(&["one", "two"])).unwrap();
    std::fs::rename(&tmp, &config).unwrap();

    let snapshot = wait_for(&mut rx, |s| s.entries.len() == 2).await;
    assert!(snapshot
        .entries
        .iter()
        .all(|e| e.source_path == config.display().to_string()));
    sync.stop();
}

#[tokio::test]
async fn atomic_rename_replace_of_an_explicit_file_is_detected_repeatedly() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("my-cluster.yaml");
    std::fs::write(&config, config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![file_source(&config)], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    for names in [&["a", "b"][..], &["a", "b", "c"][..]] {
        let tmp = dir.path().join("my-cluster.yaml.tmp");
        std::fs::write(&tmp, config_with(names)).unwrap();
        std::fs::rename(&tmp, &config).unwrap();
        wait_for(&mut rx, |s| s.entries.len() == names.len()).await;
    }
    sync.stop();
}

#[tokio::test]
async fn lock_files_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("config"), config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    let before = wait_for(&mut rx, |s| s.entries.len() == 1).await;

    std::fs::write(dir.path().join("config.lock"), "clusters: [garbage").unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let after = rx.borrow().clone();
    assert_eq!(after, before);
    assert!(after.warnings.is_empty());
    sync.stop();
}

#[tokio::test]
async fn parse_failure_keeps_previous_entries_and_warns() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    std::fs::write(&config, config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    std::fs::write(&config, "clusters: [unterminated").unwrap();

    let snapshot = wait_for(&mut rx, |s| s.warnings.len() == 1).await;
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].context_name, "one");
    assert_eq!(snapshot.warnings[0].path, config.display().to_string());
    assert!(!snapshot.warnings[0].message.is_empty());

    // Fixing the file clears the warning.
    std::fs::write(&config, config_with(&["one", "two"])).unwrap();
    let snapshot = wait_for(&mut rx, |s| s.warnings.is_empty()).await;
    assert_eq!(snapshot.entries.len(), 2);
    sync.stop();
}

#[tokio::test]
async fn removed_context_disappears() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    std::fs::write(&config, config_with(&["one", "two"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 2).await;

    std::fs::write(&config, config_with(&["two"])).unwrap();

    let snapshot = wait_for(&mut rx, |s| s.entries.len() == 1).await;
    assert_eq!(snapshot.entries[0].context_name, "two");
    sync.stop();
}

#[tokio::test]
async fn deleted_file_removes_its_entries() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    std::fs::write(&config, config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    std::fs::remove_file(&config).unwrap();

    let snapshot = wait_for(&mut rx, |s| s.entries.is_empty()).await;
    assert!(snapshot.warnings.is_empty());
    sync.stop();
}

#[tokio::test]
async fn missing_kube_dir_created_later_is_detected() {
    let root = tempfile::tempdir().unwrap();
    let kube = root.path().join("nested").join(".kube");
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(&kube)], Duration::from_millis(200));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(rx.borrow().entries.is_empty());

    std::fs::create_dir_all(&kube).unwrap();
    std::fs::write(kube.join("config"), config_with(&["one"])).unwrap();

    wait_for(&mut rx, |s| s.entries.len() == 1).await;
    sync.stop();
}

#[tokio::test]
async fn missing_dir_created_later_is_detected_through_its_ancestor_watch() {
    let root = tempfile::tempdir().unwrap();
    let kube = root.path().join("nested").join(".kube");
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(&kube)], NO_POLL);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // One level at a time, so each new directory must extend the watch chain.
    std::fs::create_dir(root.path().join("nested")).unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    std::fs::create_dir(&kube).unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    std::fs::write(kube.join("config"), config_with(&["one"])).unwrap();

    wait_for(&mut rx, |s| s.entries.len() == 1).await;
    sync.stop();
}

#[cfg(unix)]
#[tokio::test]
async fn watched_dir_replaced_by_a_new_one_is_watched_again() {
    let root = tempfile::tempdir().unwrap();
    let kube = root.path().join(".kube");
    std::fs::create_dir(&kube).unwrap();
    std::fs::write(kube.join("config"), config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(&kube)], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    std::fs::rename(&kube, root.path().join(".kube.old")).unwrap();
    std::fs::create_dir(&kube).unwrap();
    wait_for(&mut rx, |s| s.entries.is_empty()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    std::fs::write(kube.join("config"), config_with(&["two"])).unwrap();

    let snapshot = wait_for(&mut rx, |s| s.entries.len() == 1).await;
    assert_eq!(snapshot.entries[0].context_name, "two");
    sync.stop();
}

#[cfg(unix)]
#[tokio::test]
async fn watched_dir_deleted_and_recreated_is_watched_again() {
    let root = tempfile::tempdir().unwrap();
    let kube = root.path().join(".kube");
    std::fs::create_dir(&kube).unwrap();
    std::fs::write(kube.join("config"), config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(&kube)], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    std::fs::remove_dir_all(&kube).unwrap();
    wait_for(&mut rx, |s| s.entries.is_empty()).await;

    std::fs::create_dir(&kube).unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    std::fs::write(kube.join("config"), config_with(&["two"])).unwrap();

    let snapshot = wait_for(&mut rx, |s| s.entries.len() == 1).await;
    assert_eq!(snapshot.entries[0].context_name, "two");
    sync.stop();
}

#[tokio::test]
async fn dir_scan_skips_hidden_cache_and_unrelated_yaml() {
    let dir = tempfile::tempdir().unwrap();
    let valid = config_with(&["ignored"]);
    std::fs::write(dir.path().join(".hidden"), &valid).unwrap();
    std::fs::write(dir.path().join("config.bak"), &valid).unwrap();
    std::fs::write(dir.path().join("config~"), &valid).unwrap();
    std::fs::create_dir(dir.path().join("cache")).unwrap();
    std::fs::write(dir.path().join("cache").join("config"), &valid).unwrap();
    std::fs::write(dir.path().join("notes.txt"), "remember the milk\n").unwrap();
    std::fs::write(
        dir.path().join("values.yaml"),
        "replicas: 3\nimage: nginx\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("config"), config_with(&["real"])).unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| !s.entries.is_empty()).await;
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].context_name, "real");
    assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
    sync.stop();
}

#[tokio::test]
async fn explicit_file_with_invalid_yaml_warns_even_on_first_scan() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("broken.yaml");
    std::fs::write(&file, "foo: [unterminated").unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![file_source(&file)], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| s.warnings.len() == 1).await;
    assert!(snapshot.entries.is_empty());
    assert_eq!(snapshot.warnings[0].path, file.display().to_string());
    sync.stop();
}

#[tokio::test]
async fn explicit_file_of_the_wrong_shape_warns_without_quoting_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("token.txt");
    std::fs::write(&file, "SECRET-TOKEN-abc123\n").unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![file_source(&file)], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| s.warnings.len() == 1).await;
    let message = &snapshot.warnings[0].message;
    assert!(!message.contains("SECRET"), "{message}");
    sync.stop();
}

/// Sets a directory's mode for the test, and restores it so the temp dir can be removed.
#[cfg(unix)]
struct DirMode<'a>(&'a Path);

#[cfg(unix)]
impl<'a> DirMode<'a> {
    fn set(dir: &'a Path, mode: u32) -> Self {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode)).unwrap();
        Self(dir)
    }
}

#[cfg(unix)]
impl Drop for DirMode<'_> {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(self.0, std::fs::Permissions::from_mode(0o700));
    }
}

/// Removes a dir-scanned file's access through `mode`, expects its entries to
/// stay across several polls with a warning at the path `warned(dir, file)`,
/// then expects a normal scan to resume once access is back.
#[cfg(unix)]
async fn entries_survive_dir_mode(mode: u32, warned: fn(&Path, &Path) -> String) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("config");
    std::fs::write(&file, config_with(&["one"])).unwrap();
    let poll = Duration::from_millis(50);
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], poll);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    let restricted = DirMode::set(dir.path(), mode);
    if std::fs::metadata(&file).is_ok() && std::fs::read_dir(dir.path()).is_ok() {
        eprintln!("skipped: this user is not restricted by directory modes");
        return;
    }

    let expected = warned(dir.path(), &file);
    let snapshot = wait_for(&mut rx, |s| s.warnings.iter().any(|w| w.path == expected)).await;
    assert_eq!(snapshot.entries.len(), 1, "{snapshot:?}");
    tokio::time::sleep(poll * 4).await;
    assert_eq!(rx.borrow().entries.len(), 1, "{:?}", *rx.borrow());

    drop(restricted);
    std::fs::write(&file, config_with(&["one", "two"])).unwrap();
    let snapshot = wait_for(&mut rx, |s| s.entries.len() == 2 && s.warnings.is_empty()).await;
    assert_eq!(snapshot.entries[1].context_name, "two");
    sync.stop();
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_dir_keeps_its_entries_and_warns() {
    entries_survive_dir_mode(0o000, |dir, _| dir.display().to_string()).await;
}

#[cfg(unix)]
#[tokio::test]
async fn dir_whose_files_cannot_be_examined_keeps_its_entries_and_warns() {
    // Readable but not searchable: listing works, and every stat of a file fails.
    entries_survive_dir_mode(0o400, |_, file| file.display().to_string()).await;
}

#[cfg(unix)]
#[tokio::test]
async fn first_scan_of_an_unreadable_dir_only_warns() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("config"), config_with(&["one"])).unwrap();
    let _restricted = DirMode::set(dir.path(), 0o000);
    if std::fs::read_dir(dir.path()).is_ok() {
        eprintln!("skipped: this user is not restricted by directory modes");
        return;
    }

    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| !s.warnings.is_empty()).await;
    assert!(snapshot.entries.is_empty());
    assert_eq!(snapshot.warnings[0].path, dir.path().display().to_string());
    sync.stop();
}

#[tokio::test]
async fn missing_explicit_file_gives_no_warning_and_is_picked_up_when_created() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("later.yaml");
    let (sync, mut rx) = KubeconfigSync::start(vec![file_source(&file)], NO_POLL);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(*rx.borrow(), SyncSnapshot::default());

    std::fs::write(&file, config_with(&["one"])).unwrap();

    wait_for(&mut rx, |s| s.entries.len() == 1).await;
    sync.stop();
}

#[tokio::test]
async fn first_seen_dir_file_that_fails_to_parse_warns_only_if_it_looks_like_a_kubeconfig() {
    let dir = tempfile::tempdir().unwrap();
    let named_config = dir.path().join("config");
    let with_marker = dir.path().join("staging.yaml");
    std::fs::write(&named_config, "foo: [unterminated").unwrap();
    std::fs::write(&with_marker, "kind: Config\nfoo: [unterminated").unwrap();
    std::fs::write(dir.path().join("unrelated.yaml"), "foo: [unterminated").unwrap();
    std::fs::write(dir.path().join("binary.dat"), [0xFF, 0xFE, 0x00, 0x01]).unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| !s.warnings.is_empty()).await;
    let paths: Vec<&str> = snapshot.warnings.iter().map(|w| w.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            named_config.display().to_string(),
            with_marker.display().to_string()
        ]
    );
    assert!(snapshot.entries.is_empty());
    sync.stop();
}

#[tokio::test]
async fn dir_file_that_stops_looking_like_a_kubeconfig_keeps_entries_and_warns() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("dev.yaml");
    std::fs::write(&file, config_with(&["one"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    std::fs::write(&file, "replicas: 3\n").unwrap();
    let snapshot = wait_for(&mut rx, |s| s.warnings.len() == 1).await;
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.warnings[0].path, file.display().to_string());

    // The same holds for text that does not parse and has no kubeconfig marker.
    std::fs::write(&file, config_with(&["one", "two"])).unwrap();
    wait_for(&mut rx, |s| s.entries.len() == 2 && s.warnings.is_empty()).await;
    std::fs::write(&file, "foo: [unterminated").unwrap();
    let snapshot = wait_for(&mut rx, |s| s.warnings.len() == 1).await;
    assert_eq!(snapshot.entries.len(), 2);
    sync.stop();
}

#[tokio::test]
async fn oversized_file_is_skipped_with_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.yaml");
    let file = std::fs::File::create(&big).unwrap();
    file.set_len(10 * 1024 * 1024 + 1).unwrap();
    drop(file);
    std::fs::write(dir.path().join("config"), config_with(&["one"])).unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| !s.entries.is_empty()).await;
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.warnings.len(), 1);
    assert_eq!(snapshot.warnings[0].path, big.display().to_string());
    sync.stop();
}

#[tokio::test]
async fn overlapping_sources_dedupe_and_keep_the_given_path() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    std::fs::write(&config, config_with(&["one"])).unwrap();

    let (sync, mut rx) =
        KubeconfigSync::start(vec![dir_source(dir.path()), file_source(&config)], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| !s.entries.is_empty()).await;
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(
        snapshot.entries[0].source_path,
        config.display().to_string()
    );
    sync.stop();
}

#[tokio::test]
async fn explicit_file_inside_a_watched_dir_still_warns_on_invalid_yaml() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("unrelated.yaml");
    std::fs::write(&file, "foo: [unterminated").unwrap();

    let (sync, mut rx) =
        KubeconfigSync::start(vec![dir_source(dir.path()), file_source(&file)], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| !s.warnings.is_empty()).await;
    assert_eq!(snapshot.warnings.len(), 1);
    assert_eq!(snapshot.warnings[0].path, file.display().to_string());
    sync.stop();
}

#[tokio::test]
async fn entries_sort_by_context_name_then_path() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), config_with(&["zeta", "same"])).unwrap();
    std::fs::write(dir.path().join("b"), config_with(&["alpha", "same"])).unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| s.entries.len() == 4).await;
    let order: Vec<(String, String)> = snapshot
        .entries
        .iter()
        .map(|e| {
            let file = Path::new(&e.source_path).file_name().unwrap();
            (e.context_name.clone(), file.to_string_lossy().into_owned())
        })
        .collect();
    let expected = [("alpha", "b"), ("same", "a"), ("same", "b"), ("zeta", "a")]
        .map(|(c, f)| (c.to_string(), f.to_string()));
    assert_eq!(order, expected);
    sync.stop();
}

#[tokio::test]
async fn set_sources_takes_effect_and_drops_removed_entries() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    std::fs::write(first.path().join("config"), config_with(&["one"])).unwrap();
    std::fs::write(second.path().join("config"), config_with(&["two"])).unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(first.path())], NO_POLL);
    wait_for(&mut rx, |s| s.entries.len() == 1).await;

    sync.set_sources(vec![dir_source(second.path())]);
    let snapshot = wait_for(&mut rx, |s| {
        s.entries.len() == 1 && s.entries[0].context_name == "two"
    })
    .await;
    assert!(snapshot.warnings.is_empty());

    // The new source is watched and the old one no longer contributes.
    std::fs::write(second.path().join("extra"), config_with(&["three"])).unwrap();
    wait_for(&mut rx, |s| s.entries.len() == 2).await;
    std::fs::write(first.path().join("extra"), config_with(&["four"])).unwrap();
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(rx.borrow().entries.len(), 2);
    sync.stop();
}

#[tokio::test]
async fn unchanged_rescans_send_no_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("config"), config_with(&["one"])).unwrap();
    let (sync, mut rx) =
        KubeconfigSync::start(vec![dir_source(dir.path())], Duration::from_millis(50));
    wait_for(&mut rx, |s| s.entries.len() == 1).await;
    rx.mark_unchanged();

    // Same content, new mtime, plus many polls.
    std::fs::write(dir.path().join("config"), config_with(&["one"])).unwrap();
    tokio::time::sleep(Duration::from_millis(1000)).await;

    assert!(!rx.has_changed().unwrap());
    sync.stop();
}

#[tokio::test]
async fn stop_ends_the_watcher() {
    let dir = tempfile::tempdir().unwrap();
    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    sync.stop();

    // The worker owned the sender, so stopping closes the channel.
    let closed = async { while rx.changed().await.is_ok() {} };
    tokio::time::timeout(Duration::from_secs(1), closed)
        .await
        .expect("channel should close after stop");
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_config_is_read_and_its_target_is_watched() {
    let elsewhere = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let target = elsewhere.path().join("real-config");
    std::fs::write(&target, config_with(&["one"])).unwrap();
    let link = dir.path().join("config");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);
    let snapshot = wait_for(&mut rx, |s| s.entries.len() == 1).await;
    // The id belongs to the path the source gives, not to the link's target.
    assert_eq!(snapshot.entries[0].source_path, link.display().to_string());

    std::fs::write(&target, config_with(&["one", "two"])).unwrap();
    wait_for(&mut rx, |s| s.entries.len() == 2).await;
    sync.stop();
}

#[cfg(unix)]
#[tokio::test]
async fn dangling_symlink_is_silently_ignored() {
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("dangling")).unwrap();
    std::fs::write(dir.path().join("config"), config_with(&["one"])).unwrap();

    let (sync, mut rx) = KubeconfigSync::start(vec![dir_source(dir.path())], NO_POLL);

    let snapshot = wait_for(&mut rx, |s| !s.entries.is_empty()).await;
    assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
    sync.stop();
}
