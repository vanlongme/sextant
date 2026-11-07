//! The local terminal (F11): a shell in a PTY, with the cluster's kubeconfig.
//!
//! PTY reads, writes and waits all block, so each has a plain thread. `spawn_blocking` is
//! not used for them, because a read that never returns would hang runtime shutdown.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::{FlowControl, SessionEvent, SessionOutput, TerminalControl, TerminalSize};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

const READ_CHUNK: usize = 16 * 1024;
const INPUT_BACKLOG: usize = 64;
/// How often the waiter looks at the child.
const WAIT_POLL: Duration = Duration::from_millis(50);
/// After the shell has gone, how long what is left in the PTY may take to arrive.
const DRAIN_LIMIT: Duration = Duration::from_secs(2);
/// How long a stopped shell may take to die: SIGHUP, a grace period, then SIGKILL.
const KILL_LIMIT: Duration = Duration::from_secs(2);

/// Prefs, else `$SHELL`, else `/bin/sh` (F11).
fn unix_shell(configured: Option<&str>, env_shell: Option<&str>) -> String {
    configured
        .or(env_shell)
        .filter(|shell| !shell.is_empty())
        .unwrap_or("/bin/sh")
        .to_owned()
}

/// Prefs, else `pwsh`, else `powershell`, else `%COMSPEC%` (F11).
fn windows_shell(
    configured: Option<&str>,
    on_path: impl Fn(&str) -> bool,
    comspec: Option<&str>,
) -> String {
    if let Some(shell) = configured.filter(|shell| !shell.is_empty()) {
        return shell.to_owned();
    }
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if on_path(candidate) {
            return candidate.to_owned();
        }
    }
    comspec.unwrap_or("cmd.exe").to_owned()
}

fn is_on_path(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|folder| folder.join(program).is_file())
    })
}

/// Which branch runs is decided at run time, so that neither is dead code on any OS.
fn resolve_shell(configured: Option<&str>) -> String {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").ok();
        windows_shell(configured, is_on_path, comspec.as_deref())
    } else {
        let env_shell = std::env::var("SHELL").ok();
        unix_shell(configured, env_shell.as_deref())
    }
}

/// The cluster's folder when it exists, else home.
fn working_directory(configured: Option<&str>, home: &Path) -> PathBuf {
    configured
        .map(PathBuf::from)
        .filter(|folder| folder.is_dir())
        .unwrap_or_else(|| home.to_path_buf())
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows.max(1),
        cols: size.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn pty_error(error: impl std::fmt::Display) -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        format!("the terminal could not start: {error}"),
    )
}

struct TerminalSpec {
    shell: String,
    kubeconfig: PathBuf,
    cwd: PathBuf,
    size: TerminalSize,
}

struct OpenTerminal {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn open_terminal(spec: &TerminalSpec) -> CoreResult<OpenTerminal> {
    let pair = native_pty_system()
        .openpty(pty_size(spec.size))
        .map_err(pty_error)?;
    let mut command = CommandBuilder::new(&spec.shell);
    command.env("KUBECONFIG", &spec.kubeconfig);
    command.env("TERM", "xterm-256color");
    command.cwd(&spec.cwd);
    let child = pair.slave.spawn_command(command).map_err(pty_error)?;
    // While this end stays open here, reading the master never sees the shell's exit.
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(pty_error)?;
    let writer = pair.master.take_writer().map_err(pty_error)?;
    Ok(OpenTerminal {
        master: pair.master,
        reader,
        writer,
        child,
    })
}

/// Reads until the PTY closes. Output is discarded once nobody takes it, because on
/// Windows the PTY only closes after what it holds has been read.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    flow: Arc<FlowControl>,
    output: mpsc::Sender<SessionOutput>,
    token: CancellationToken,
) -> oneshot::Receiver<()> {
    let handle = Handle::current();
    let (done, done_rx) = oneshot::channel();
    std::thread::spawn(move || {
        let mut chunk = vec![0; READ_CHUNK];
        let mut listening = true;
        loop {
            handle.block_on(flow.ready());
            let count = match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if !listening {
                continue;
            }
            flow.sent(count as u64);
            let data = SessionOutput::Data(chunk[..count].to_vec());
            if output.blocking_send(data).is_err() {
                listening = false;
                token.cancel();
            }
        }
        let _ = done.send(());
    });
    done_rx
}

/// Ends when the session drops its `TerminalControl`, which closes `input`.
fn spawn_writer(mut writer: Box<dyn Write + Send>, mut input: mpsc::Receiver<Vec<u8>>) {
    std::thread::spawn(move || {
        while let Some(data) = input.blocking_recv() {
            if writer
                .write_all(&data)
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
}

/// Owns the child and polls it instead of blocking in `wait`, because only the child's own
/// `kill` follows SIGHUP with SIGKILL. A killer cloned from it sends SIGHUP alone, which a
/// shell may ignore, and that would leave a process behind after the session ended.
fn spawn_waiter(
    mut child: Box<dyn Child + Send + Sync>,
    token: CancellationToken,
) -> oneshot::Receiver<Option<u32>> {
    let (exit, exit_rx) = oneshot::channel();
    std::thread::spawn(move || {
        let mut killed = false;
        let code = loop {
            if token.is_cancelled() && !killed {
                killed = true;
                let _ = child.kill();
            }
            match child.try_wait() {
                Ok(Some(status)) => break Some(status.exit_code()),
                Ok(None) => std::thread::sleep(WAIT_POLL),
                Err(_) => break None,
            }
        };
        let _ = exit.send(code);
    });
    exit_rx
}

/// Closes the PTY on a thread of its own, also when a stopping runtime drops the session's
/// task. Closing a Windows PTY blocks until its output has been read, and until the cursor
/// position it asked the terminal for has been answered.
struct Master(Option<Box<dyn MasterPty + Send>>);

impl Master {
    fn resize(&self, size: TerminalSize) {
        if let Some(master) = &self.0 {
            // A failed resize leaves the old size, which is still usable.
            let _ = master.resize(pty_size(size));
        }
    }
}

impl Drop for Master {
    fn drop(&mut self) {
        if let Some(master) = self.0.take() {
            std::thread::spawn(move || drop(master));
        }
    }
}

/// Runs until the shell exits or the session stops. Returns the exit code to report, and
/// the master for the caller to close.
async fn run_until_exit(
    master: Master,
    token: &CancellationToken,
    resize: &mut watch::Receiver<TerminalSize>,
    exit: &mut oneshot::Receiver<Option<u32>>,
) -> (Option<u32>, Master) {
    loop {
        tokio::select! {
            // A stop wins over an exit that is ready too, since stopping caused that exit.
            biased;
            () = token.cancelled() => {
                // The code of a process we killed means nothing, so none is reported.
                let _ = tokio::time::timeout(KILL_LIMIT, exit).await;
                return (None, master);
            }
            code = &mut *exit => return (code.unwrap_or(None), master),
            changed = resize.changed() => {
                if changed.is_ok() {
                    let size = *resize.borrow_and_update();
                    master.resize(size);
                }
            }
        }
    }
}

impl AppCore {
    /// Starts a shell with the cluster's kubeconfig. The cluster must be connected, because
    /// that file exists only then. Output and events go to `output`.
    pub async fn terminal_start(
        &self,
        id: &ClusterId,
        size: TerminalSize,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let token = self.cluster_cancel_token(id)?;
        let settings = self.cluster_settings_get(id);
        let prefs = self.prefs_get();
        let spec = TerminalSpec {
            shell: resolve_shell(prefs.terminal_shell.as_deref()),
            kubeconfig,
            cwd: working_directory(settings.terminal_cwd.as_deref(), self.home_dir()),
            size,
        };
        let opened = tokio::task::spawn_blocking(move || open_terminal(&spec))
            .await
            .map_err(pty_error)??;
        let OpenTerminal {
            master,
            reader,
            writer,
            child,
        } = opened;

        let flow = Arc::new(FlowControl::new());
        let (input, input_rx) = mpsc::channel(INPUT_BACKLOG);
        let (resize, mut resize_rx) = watch::channel(size);
        let guard = self.sessions().register(
            token.clone(),
            Some(TerminalControl {
                input: Some(input),
                resize,
                flow: flow.clone(),
            }),
        );
        let session = guard.id().to_owned();
        spawn_writer(writer, input_rx);
        let mut exit = spawn_waiter(child, token.clone());

        tokio::spawn(async move {
            // Before the reader starts, so that no output can overtake it.
            let _ = output
                .send(SessionOutput::Event(SessionEvent::Started { tty: true }))
                .await;
            let reader_done = spawn_reader(reader, flow.clone(), output.clone(), token.clone());
            let master = Master(Some(master));
            let (code, master) = run_until_exit(master, &token, &mut resize_rx, &mut exit).await;
            // Nothing acknowledges from here on, and a paused reader would never finish.
            flow.release();
            // Closing lets the reader see the end of the output.
            drop(master);
            let _ = tokio::time::timeout(DRAIN_LIMIT, reader_done).await;
            let _ = output
                .send(SessionOutput::Event(SessionEvent::Exited { code }))
                .await;
            drop(guard);
        });
        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The waiter kills the shell as soon as it sees the token, so its exit is often ready
    /// by the time the session looks. `select!` picks at random among ready branches.
    #[tokio::test]
    async fn a_stopped_session_reports_no_code_even_when_the_exit_is_ready_too() {
        for _ in 0..50 {
            let token = CancellationToken::new();
            token.cancel();
            let (killed, mut exit) = oneshot::channel();
            killed.send(Some(1)).unwrap();
            let (_resize, mut resize_rx) = watch::channel(TerminalSize { cols: 80, rows: 24 });
            let (code, _master) =
                run_until_exit(Master(None), &token, &mut resize_rx, &mut exit).await;
            assert_eq!(code, None);
        }
    }

    #[test]
    fn unix_prefers_prefs_then_the_environment_then_sh() {
        assert_eq!(unix_shell(Some("/bin/zsh"), Some("/bin/bash")), "/bin/zsh");
        assert_eq!(unix_shell(None, Some("/bin/bash")), "/bin/bash");
        assert_eq!(unix_shell(None, None), "/bin/sh");
        assert_eq!(unix_shell(None, Some("")), "/bin/sh");
    }

    #[test]
    fn windows_prefers_prefs_then_pwsh_then_powershell_then_comspec() {
        let cmd = Some("C:\\Windows\\cmd.exe");
        assert_eq!(windows_shell(Some("nu.exe"), |_| true, cmd), "nu.exe");
        assert_eq!(windows_shell(None, |_| true, cmd), "pwsh.exe");
        assert_eq!(
            windows_shell(None, |name| name == "powershell.exe", cmd),
            "powershell.exe"
        );
        assert_eq!(windows_shell(None, |_| false, cmd), "C:\\Windows\\cmd.exe");
        assert_eq!(windows_shell(None, |_| false, None), "cmd.exe");
    }

    #[test]
    fn the_working_directory_falls_back_to_home() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let folder = other.path().to_str().unwrap();
        assert_eq!(working_directory(Some(folder), home.path()), other.path());
        assert_eq!(working_directory(None, home.path()), home.path());
        let missing = other.path().join("missing");
        assert_eq!(
            working_directory(missing.to_str(), home.path()),
            home.path()
        );
    }

    #[test]
    fn a_zero_size_is_raised_to_one_cell() {
        let size = pty_size(TerminalSize { cols: 0, rows: 0 });
        assert_eq!((size.cols, size.rows), (1, 1));
    }
}
