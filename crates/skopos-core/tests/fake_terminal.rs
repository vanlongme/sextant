//! The local terminal, with real shells on each OS. The cluster behind it is the fake: the
//! terminal needs a connection only for the kubeconfig. Output is searched for what the
//! test itself made the shell print, never for wording from the OS.

mod support;

use std::time::Duration;

use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::{ClusterSettings, Prefs};
use skopos_core::sessions::{SessionEvent, SessionOutput, TerminalSize};
use skopos_fakekube::FakeKubeConfig;
use support::connected_fake;
use tokio::sync::mpsc;

const LIMIT: Duration = Duration::from_secs(30);
/// Wide, so that no OS wraps a long path across lines.
const WIDE: TerminalSize = TerminalSize {
    cols: 500,
    rows: 50,
};

fn test_shell() -> &'static str {
    if cfg!(windows) {
        "cmd.exe"
    } else {
        "/bin/sh"
    }
}

async fn start_shell(
    core: &AppCore,
    id: &ClusterId,
    size: TerminalSize,
) -> (String, mpsc::Receiver<SessionOutput>) {
    core.prefs_set(Prefs {
        terminal_shell: Some(test_shell().to_owned()),
        ..core.prefs_get()
    })
    .unwrap();
    let (tx, rx) = mpsc::channel(32);
    (core.terminal_start(id, size, tx).await.unwrap(), rx)
}

/// Runs a command in the shell. `\r` is Enter on every OS.
fn run(core: &AppCore, session: &str, command: &str) {
    core.session_write(session, format!("{command}\r").into_bytes())
        .unwrap();
}

/// Reads and acknowledges output until it contains `wanted`.
async fn wait_for_text(
    core: &AppCore,
    session: &str,
    rx: &mut mpsc::Receiver<SessionOutput>,
    wanted: &str,
) -> String {
    let mut text = String::new();
    tokio::time::timeout(LIMIT, async {
        while !text.contains(wanted) {
            match rx.recv().await {
                Some(SessionOutput::Data(data)) => {
                    core.session_ack(session, data.len() as u64);
                    text.push_str(&String::from_utf8_lossy(&data));
                }
                Some(SessionOutput::Event(_)) => {}
                None => panic!("the session ended before {wanted:?}: {text}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{wanted:?} never came: {text}"));
    text
}

/// Reads and acknowledges output until the session says it exited.
async fn wait_for_exit(
    core: &AppCore,
    session: &str,
    rx: &mut mpsc::Receiver<SessionOutput>,
) -> Option<u32> {
    tokio::time::timeout(LIMIT, async {
        loop {
            match rx.recv().await {
                Some(SessionOutput::Data(data)) => core.session_ack(session, data.len() as u64),
                Some(SessionOutput::Event(SessionEvent::Exited { code })) => return code,
                Some(SessionOutput::Event(_)) => {}
                None => panic!("the session ended without an exit event"),
            }
        }
    })
    .await
    .expect("no exit event")
}

#[tokio::test]
async fn the_shell_starts_with_the_kubeconfig_and_says_started() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (session, mut rx) = start_shell(&core, &id, WIDE).await;
    assert!(matches!(
        rx.recv().await,
        Some(SessionOutput::Event(SessionEvent::Started { tty: true }))
    ));
    run(
        &core,
        &session,
        if cfg!(windows) {
            "echo %KUBECONFIG%"
        } else {
            "echo $KUBECONFIG"
        },
    );
    let expected = core.cluster_kubeconfig_path(&id).unwrap();
    wait_for_text(&core, &session, &mut rx, expected.to_str().unwrap()).await;
    core.session_stop(&session);
    assert_eq!(wait_for_exit(&core, &session, &mut rx).await, None);
    assert!(core.sessions_wait_idle(LIMIT).await);
}

#[tokio::test]
async fn the_shell_runs_in_the_clusters_folder() {
    let (core, _fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    let folder = root.path().join("terminal-folder-mark");
    std::fs::create_dir(&folder).unwrap();
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            terminal_cwd: Some(folder.to_str().unwrap().to_owned()),
            ..ClusterSettings::default()
        },
    )
    .unwrap();
    let (session, mut rx) = start_shell(&core, &id, WIDE).await;
    run(&core, &session, if cfg!(windows) { "cd" } else { "pwd" });
    // Only the last part: temp paths have other spellings once resolved on some OSes.
    wait_for_text(&core, &session, &mut rx, "terminal-folder-mark").await;
    core.session_stop(&session);
    wait_for_exit(&core, &session, &mut rx).await;
}

#[tokio::test]
async fn the_exit_code_is_reported() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (session, mut rx) = start_shell(&core, &id, WIDE).await;
    run(&core, &session, "exit 7");
    assert_eq!(wait_for_exit(&core, &session, &mut rx).await, Some(7));
    assert!(core.sessions_wait_idle(LIMIT).await);
}

#[tokio::test]
async fn stopping_twice_is_safe_and_disconnecting_stops_the_terminal() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (first, mut first_rx) = start_shell(&core, &id, WIDE).await;
    core.session_stop(&first);
    core.session_stop(&first);
    assert_eq!(wait_for_exit(&core, &first, &mut first_rx).await, None);
    core.session_stop(&first);

    let (second, mut second_rx) = start_shell(&core, &id, WIDE).await;
    core.cluster_disconnect(&id).await.unwrap();
    assert_eq!(wait_for_exit(&core, &second, &mut second_rx).await, None);
    assert!(core.sessions_wait_idle(LIMIT).await);
}

#[tokio::test]
async fn a_cluster_that_is_not_connected_is_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    core.cluster_disconnect(&id).await.unwrap();
    let (tx, _rx) = mpsc::channel(4);
    let error = core.terminal_start(&id, WIDE, tx).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable);
    assert_eq!(core.session_count(), 0);
}

#[cfg(unix)]
mod unix_only {
    use super::*;

    fn is_running(pid: &str) -> bool {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    async fn wait_until_gone(pid: &str) {
        tokio::time::timeout(LIMIT, async {
            while is_running(pid) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the process is still running");
    }

    /// The digits in `pid=<digits>-ready`. The terminal also echoes the command as typed,
    /// with `$$` where the digits go, so seeing the marker alone proves nothing.
    fn pid_in(text: &str) -> Option<String> {
        text.split("pid=").skip(1).find_map(|after| {
            let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
            let printed = !digits.is_empty() && after[digits.len()..].starts_with("-ready");
            printed.then_some(digits)
        })
    }

    /// Runs a command that prints `pid=$$-ready` and returns the pid.
    async fn run_for_pid(
        core: &AppCore,
        session: &str,
        rx: &mut mpsc::Receiver<SessionOutput>,
        command: &str,
    ) -> String {
        run(core, session, command);
        let mut text = String::new();
        tokio::time::timeout(LIMIT, async {
            loop {
                if let Some(pid) = pid_in(&text) {
                    return pid;
                }
                match rx.recv().await {
                    Some(SessionOutput::Data(data)) => {
                        core.session_ack(session, data.len() as u64);
                        text.push_str(&String::from_utf8_lossy(&data));
                    }
                    Some(SessionOutput::Event(_)) => {}
                    None => panic!("the session ended: {text}"),
                }
            }
        })
        .await
        .expect("the pid never came")
    }

    #[tokio::test]
    async fn a_resize_reaches_the_shell() {
        let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
        let (session, mut rx) = start_shell(&core, &id, WIDE).await;
        core.session_resize(&session, TerminalSize { cols: 91, rows: 37 });
        // The command is typed after the resize but may run before the PTY applies it.
        tokio::time::sleep(Duration::from_millis(200)).await;
        run(&core, &session, "stty size");
        wait_for_text(&core, &session, &mut rx, "37 91").await;
        core.session_stop(&session);
        wait_for_exit(&core, &session, &mut rx).await;
    }

    #[tokio::test]
    async fn a_flood_stops_at_the_limit_until_acknowledged_and_stop_ends_the_process() {
        let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
        let (session, mut rx) = start_shell(&core, &id, WIDE).await;
        // `exec` makes the printed pid the flooding process itself.
        let pid = run_for_pid(&core, &session, &mut rx, "echo pid=$$-ready; exec yes").await;

        // With nothing acknowledged, output must stop at 1 MiB and one last chunk. The
        // channel's backlog is what is left of it.
        let mut unacked = 0;
        let limit = 1024 * 1024 + 16 * 1024;
        loop {
            let wait = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
            match wait {
                Ok(Some(SessionOutput::Data(data))) => {
                    unacked += data.len();
                    assert!(
                        unacked <= limit,
                        "{unacked} bytes without an acknowledgement"
                    );
                }
                Ok(other) => panic!("{other:?}"),
                Err(_) => break,
            }
        }
        assert!(unacked >= 512 * 1024, "stopped early, at {unacked}");
        assert!(is_running(&pid));

        // Acknowledging lets it go on.
        core.session_ack(&session, unacked as u64);
        let more = tokio::time::timeout(LIMIT, rx.recv()).await.unwrap();
        assert!(matches!(more, Some(SessionOutput::Data(_))));

        core.session_stop(&session);
        wait_for_exit(&core, &session, &mut rx).await;
        wait_until_gone(&pid).await;
        assert!(core.sessions_wait_idle(LIMIT).await);
    }

    #[tokio::test]
    async fn a_shell_that_ignores_hangup_still_goes() {
        let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
        let (session, mut rx) = start_shell(&core, &id, WIDE).await;
        let pid = run_for_pid(&core, &session, &mut rx, "trap '' HUP; echo pid=$$-ready").await;
        assert!(is_running(&pid));
        core.session_stop(&session);
        assert_eq!(wait_for_exit(&core, &session, &mut rx).await, None);
        wait_until_gone(&pid).await;
    }

    #[tokio::test]
    async fn dropping_the_receiver_stops_a_flooding_session() {
        let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
        let (session, rx) = start_shell(&core, &id, WIDE).await;
        run(&core, &session, "exec yes");
        drop(rx);
        assert!(core.sessions_wait_idle(LIMIT).await);
    }

    #[tokio::test]
    async fn stopping_all_leaves_no_process_behind() {
        let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
        let (session, mut rx) = start_shell(&core, &id, WIDE).await;
        let pid = run_for_pid(&core, &session, &mut rx, "echo pid=$$-ready").await;
        core.sessions_stop_all();
        wait_for_exit(&core, &session, &mut rx).await;
        wait_until_gone(&pid).await;
        assert_eq!(core.session_count(), 0);
    }
}
