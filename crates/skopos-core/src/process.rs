//! Runs helm and kubectl (spec §5.1). Arguments go as an array, never through a shell.
//! Every run has a timeout. A run that is cancelled, times out or is dropped stops its
//! process: a terminate signal, then a kill after a grace period (a kill at once on Windows).

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::error::{ErrorCode, IpcError};

/// How long a stopped process may take to exit before it is killed.
pub const KILL_GRACE: Duration = Duration::from_secs(5);
/// A streamed line longer than this arrives in pieces of this size.
pub const MAX_LINE: usize = 64 * 1024;
/// How long output may keep arriving after the process exits. A program it started can hold
/// the pipes open far longer, and is not waited for.
const DRAIN_LIMIT: Duration = Duration::from_secs(2);
const READ_CHUNK: usize = 16 * 1024;
/// A file just written can still be open in a child that another thread is forking, which
/// makes running it fail for a moment with "text file busy".
const BUSY_RETRIES: u32 = 20;
const BUSY_PAUSE: Duration = Duration::from_millis(50);
/// Keeps Windows from opening a console window for each run.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Set on top of the inherited environment.
    pub env: Vec<(OsString, OsString)>,
    /// Written to stdin, which is then closed. It can hold a password, so it is never logged.
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
    pub kill_grace: Duration,
}

impl ProcessSpec {
    pub fn new<I, A>(program: impl Into<PathBuf>, args: I, timeout: Duration) -> ProcessSpec
    where
        I: IntoIterator<Item = A>,
        A: Into<OsString>,
    {
        ProcessSpec {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: Vec::new(),
            stdin: None,
            timeout,
            kill_grace: KILL_GRACE,
        }
    }
}

/// Shows the names of environment variables and the size of stdin, never their values.
impl fmt::Debug for ProcessSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let env: Vec<&OsString> = self.env.iter().map(|(name, _)| name).collect();
        f.debug_struct("ProcessSpec")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &env)
            .field("stdin_bytes", &self.stdin.as_ref().map(Vec::len))
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

pub enum Output {
    /// Keeps up to this many bytes of each stream; the rest is read and dropped.
    Capture {
        stdout_limit: usize,
        stderr_limit: usize,
    },
    /// Sends each line as it arrives. Once the receiver is gone, lines are read and dropped.
    Stream(mpsc::Sender<OutputLine>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// One line without its line ending, or a `MAX_LINE` piece of a longer one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputLine {
    pub stream: Stream,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    /// `None` when a signal ended the process.
    pub code: Option<i32>,
    /// Empty when the output was streamed.
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl ProcessOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

#[derive(Debug)]
pub enum RunError {
    Spawn {
        program: PathBuf,
        error: std::io::Error,
    },
    TimedOut {
        program: PathBuf,
        after: Duration,
    },
    Cancelled,
}

fn program_name(program: &Path) -> String {
    program
        .file_name()
        .unwrap_or(program.as_os_str())
        .to_string_lossy()
        .into_owned()
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Spawn { program, error } => {
                write!(f, "{} could not be started: {error}", program_name(program))
            }
            RunError::TimedOut { program, after } => write!(
                f,
                "{} did not finish within {} s",
                program_name(program),
                after.as_secs()
            ),
            RunError::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl From<RunError> for IpcError {
    fn from(err: RunError) -> Self {
        use std::io::ErrorKind;
        let message = err.to_string();
        match &err {
            RunError::Spawn { program, error }
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::PermissionDenied
                ) =>
            {
                IpcError::new(ErrorCode::ToolMissing, message).with_details(program_name(program))
            }
            RunError::Spawn { .. } => IpcError::new(ErrorCode::Internal, message),
            RunError::TimedOut { .. } => IpcError::new(ErrorCode::Unreachable, message),
            RunError::Cancelled => IpcError::new(ErrorCode::Cancelled, message),
        }
    }
}

/// Runs `spec` to the end. The work happens in a task of its own, so dropping the returned
/// future stops the process the same way as `cancel` does.
pub async fn run(
    spec: ProcessSpec,
    output: Output,
    cancel: CancellationToken,
) -> Result<ProcessOutput, RunError> {
    let token = cancel.child_token();
    let _stop_when_dropped = token.clone().drop_guard();
    match tokio::spawn(run_to_end(spec, output, token)).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(_) => Err(RunError::Cancelled),
    }
}

#[derive(Default)]
struct Collected {
    bytes: Vec<u8>,
    truncated: bool,
}

type Shared = Arc<Mutex<Collected>>;

fn lock(collected: &Mutex<Collected>) -> MutexGuard<'_, Collected> {
    collected.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn run_to_end(
    spec: ProcessSpec,
    output: Output,
    token: CancellationToken,
) -> Result<ProcessOutput, RunError> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_platform(&mut command);
    let mut child = spawn(&mut command, &spec.program).await?;
    if let (Some(bytes), Some(mut stdin)) = (spec.stdin, child.stdin.take()) {
        // A process that exits without reading it closes the pipe, which is not an error here.
        tokio::spawn(async move {
            let _ = stdin.write_all(&bytes).await;
        });
    }
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let collected = [Shared::default(), Shared::default()];
    let readers = match output {
        Output::Capture {
            stdout_limit,
            stderr_limit,
        } => [
            tokio::spawn(capture(stdout, stdout_limit, collected[0].clone())),
            tokio::spawn(capture(stderr, stderr_limit, collected[1].clone())),
        ],
        Output::Stream(lines) => [
            tokio::spawn(stream_lines(stdout, Stream::Stdout, lines.clone())),
            tokio::spawn(stream_lines(stderr, Stream::Stderr, lines)),
        ],
    };
    let ended = tokio::select! {
        biased;
        () = token.cancelled() => Err(RunError::Cancelled),
        () = tokio::time::sleep(spec.timeout) => Err(RunError::TimedOut {
            program: spec.program.clone(),
            after: spec.timeout,
        }),
        status = child.wait() => Ok(status.ok().and_then(|status| status.code())),
    };
    let code = match ended {
        Ok(code) => code,
        Err(error) => {
            stop(&mut child, spec.kill_grace).await;
            for reader in &readers {
                reader.abort();
            }
            return Err(error);
        }
    };
    let deadline = tokio::time::Instant::now() + DRAIN_LIMIT;
    for reader in readers {
        let abort = reader.abort_handle();
        if tokio::time::timeout_at(deadline, reader).await.is_err() {
            abort.abort();
        }
    }
    let [stdout, stderr] = collected.map(|shared| {
        // A named guard is dropped before `shared`; a temporary in the tail would outlive it.
        let mut guard = lock(&shared);
        std::mem::take(&mut *guard)
    });
    Ok(ProcessOutput {
        code,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

async fn spawn(command: &mut Command, program: &Path) -> Result<Child, RunError> {
    let mut attempt = 0;
    loop {
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error)
                if error.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && attempt < BUSY_RETRIES =>
            {
                attempt += 1;
                tokio::time::sleep(BUSY_PAUSE).await;
            }
            Err(error) => {
                return Err(RunError::Spawn {
                    program: program.to_path_buf(),
                    error,
                })
            }
        }
    }
}

async fn capture(mut reader: impl AsyncRead + Unpin, limit: usize, into: Shared) {
    let mut chunk = vec![0; READ_CHUNK];
    while let Ok(read) = reader.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        let mut collected = lock(&into);
        let room = limit.saturating_sub(collected.bytes.len());
        collected.truncated |= read > room;
        collected.bytes.extend_from_slice(&chunk[..read.min(room)]);
    }
}

async fn stream_lines(
    mut reader: impl AsyncRead + Unpin,
    stream: Stream,
    lines: mpsc::Sender<OutputLine>,
) {
    let mut pending = Vec::new();
    let mut chunk = vec![0; READ_CHUNK];
    while let Ok(read) = reader.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..read]);
        while let Some(bytes) = take_line(&mut pending) {
            // Sending fails once nobody listens; reading goes on so the process never blocks.
            let _ = lines.send(OutputLine { stream, bytes }).await;
        }
    }
    if pending.last() == Some(&b'\r') {
        pending.pop();
    }
    if !pending.is_empty() {
        let _ = lines
            .send(OutputLine {
                stream,
                bytes: pending,
            })
            .await;
    }
}

/// The next complete line without its line ending, or a `MAX_LINE` piece of a longer one.
fn take_line(pending: &mut Vec<u8>) -> Option<Vec<u8>> {
    let window = pending.len().min(MAX_LINE + 1);
    if let Some(end) = pending[..window].iter().position(|&byte| byte == b'\n') {
        let mut line: Vec<u8> = pending.drain(..=end).collect();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        return Some(line);
    }
    (pending.len() > MAX_LINE).then(|| pending.drain(..MAX_LINE).collect())
}

/// Asks the process to stop, then kills it after `grace`.
async fn stop(child: &mut Child, grace: Duration) {
    if terminate_group(child, grace).await {
        return;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// Signals the process group, so what the process started stops too. `true` once the
/// process has exited.
#[cfg(unix)]
async fn terminate_group(child: &mut Child, grace: Duration) -> bool {
    let Some(group) = child.id().and_then(|id| libc::pid_t::try_from(id).ok()) else {
        return false;
    };
    // SAFETY: `kill` only sends a signal. The child is not reaped yet, so its id, which is
    // also its group's id, cannot belong to another process.
    unsafe { libc::kill(-group, libc::SIGTERM) };
    if tokio::time::timeout(grace, child.wait()).await.is_ok() {
        return true;
    }
    // SAFETY: as above; the wait timed out, so the child is still not reaped.
    unsafe { libc::kill(-group, libc::SIGKILL) };
    let _ = child.wait().await;
    true
}

/// Windows has no terminate signal; the caller kills the process.
#[cfg(not(unix))]
async fn terminate_group(_child: &mut Child, _grace: Duration) -> bool {
    false
}

#[cfg(unix)]
fn configure_platform(command: &mut Command) {
    // Its own process group, which a stop then signals as a whole.
    command.process_group(0);
}

#[cfg(windows)]
fn configure_platform(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
fn configure_platform(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    const LONG: Duration = Duration::from_secs(60);

    fn capture() -> Output {
        Output::Capture {
            stdout_limit: 1 << 20,
            stderr_limit: 1 << 20,
        }
    }

    /// A script for this OS: `sh -c` on Unix, Windows PowerShell on Windows.
    fn script(unix: &str, windows: &str, timeout: Duration) -> ProcessSpec {
        if cfg!(windows) {
            let args = ["-NoProfile", "-NonInteractive", "-Command", windows];
            ProcessSpec::new("powershell.exe", args, timeout)
        } else {
            ProcessSpec::new("/bin/sh", ["-c", unix], timeout)
        }
    }

    #[tokio::test]
    async fn captures_output_and_the_exit_code() {
        let spec = script(
            "printf out; printf err >&2; exit 3",
            "[Console]::Out.Write('out'); [Console]::Error.Write('err'); exit 3",
            LONG,
        );
        let output = run(spec, capture(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(output.code, Some(3));
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
        assert!(!output.success());
    }

    #[tokio::test]
    async fn output_past_the_cap_is_read_and_dropped() {
        // 200 KB is more than a pipe holds, so this hangs unless the rest is still read.
        let spec = script(
            "head -c 200000 /dev/zero",
            "[Console]::Out.Write('x' * 200000)",
            LONG,
        );
        let limits = Output::Capture {
            stdout_limit: 1000,
            stderr_limit: 1000,
        };
        let output = run(spec, limits, CancellationToken::new()).await.unwrap();
        assert_eq!(output.code, Some(0));
        assert_eq!(output.stdout.len(), 1000);
        assert!(output.stdout_truncated);
        assert!(!output.stderr_truncated);
    }

    #[tokio::test]
    async fn stdin_reaches_the_process_and_is_closed() {
        let mut spec = script(
            "cat",
            "[Console]::Out.Write([Console]::In.ReadToEnd())",
            LONG,
        );
        spec.stdin = Some(b"secret-value".to_vec());
        let output = run(spec, capture(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(output.stdout, b"secret-value");
    }

    #[tokio::test]
    async fn the_environment_is_added_to() {
        let mut spec = script(
            "printf %s \"$SKOPOS_PROCESS_TEST\"",
            "[Console]::Out.Write($env:SKOPOS_PROCESS_TEST)",
            LONG,
        );
        spec.env
            .push(("SKOPOS_PROCESS_TEST".into(), "from-spec".into()));
        let output = run(spec, capture(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(output.stdout, b"from-spec");
    }

    #[test]
    fn debug_output_hides_stdin_and_environment_values() {
        let mut spec = ProcessSpec::new("helm", ["repo", "add"], LONG);
        spec.stdin = Some(b"hunter2".to_vec());
        spec.env.push((
            "HTTPS_PROXY".into(),
            "http://user:topsecret@proxy:3128".into(),
        ));
        let text = format!("{spec:?}");
        assert!(text.contains("HTTPS_PROXY"), "{text}");
        assert!(!text.contains("hunter2"), "{text}");
        assert!(!text.contains("topsecret"), "{text}");
    }

    #[tokio::test]
    async fn a_missing_program_is_tool_missing() {
        let spec = ProcessSpec::new("skopos-no-such-program", ["version"], LONG);
        let error = run(spec, capture(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(error, RunError::Spawn { .. }), "{error:?}");
        let ipc = IpcError::from(error);
        assert_eq!(ipc.code, ErrorCode::ToolMissing);
        assert_eq!(ipc.details.as_deref(), Some("skopos-no-such-program"));
    }

    #[tokio::test]
    async fn a_run_past_its_timeout_stops() {
        let spec = script(
            "exec sleep 30",
            "Start-Sleep -Seconds 30",
            Duration::from_millis(300),
        );
        let started = Instant::now();
        let error = run(spec, capture(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(error, RunError::TimedOut { .. }), "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(IpcError::from(error).code, ErrorCode::Unreachable);
    }

    #[tokio::test]
    async fn cancelling_stops_the_process() {
        let spec = script("exec sleep 30", "Start-Sleep -Seconds 30", LONG);
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        });
        let started = Instant::now();
        let error = run(spec, capture(), token).await.unwrap_err();
        assert!(matches!(error, RunError::Cancelled), "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn long_lines_come_in_pieces() {
        let mut pending = vec![b'a'; MAX_LINE * 2 + 10];
        pending.push(b'\n');
        let mut pieces = Vec::new();
        while let Some(piece) = take_line(&mut pending) {
            pieces.push(piece.len());
        }
        assert_eq!(pieces, [MAX_LINE, MAX_LINE, 10]);
        assert!(pending.is_empty());
    }

    #[test]
    fn an_unfinished_line_waits_for_more() {
        let mut pending = b"one\r\ntwo\npartial".to_vec();
        assert_eq!(take_line(&mut pending), Some(b"one".to_vec()));
        assert_eq!(take_line(&mut pending), Some(b"two".to_vec()));
        assert_eq!(take_line(&mut pending), None);
        assert_eq!(pending, b"partial");
    }

    #[cfg(unix)]
    mod unix {
        use super::*;

        /// Zombies count as gone: nothing runs any more.
        fn is_running(pid: &str) -> bool {
            let out = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", pid])
                .output()
                .unwrap();
            let stat = String::from_utf8_lossy(&out.stdout);
            let stat = stat.trim();
            !stat.is_empty() && !stat.starts_with('Z')
        }

        async fn read_pid(file: &Path) -> String {
            for _ in 0..200 {
                if let Ok(text) = std::fs::read_to_string(file) {
                    if text.ends_with('\n') {
                        return text.trim().to_owned();
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("{} was never written", file.display());
        }

        async fn wait_until_gone(pid: &str) {
            for _ in 0..200 {
                if !is_running(pid) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("process {pid} is still running");
        }

        /// `sh -c <body>` with a file for the script to write a process id into, as `$1`.
        fn with_pid_file(body: &str, pid_file: &Path) -> ProcessSpec {
            let args = ["-c", body, "sh", pid_file.to_str().unwrap()];
            ProcessSpec::new("/bin/sh", args, LONG)
        }

        #[tokio::test]
        async fn arguments_reach_the_program_without_a_shell() {
            let spec = ProcessSpec::new("printf", ["%s|", "a b", "$HOME", "x;y", "*"], LONG);
            let output = run(spec, capture(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(output.stdout, b"a b|$HOME|x;y|*|");
        }

        #[tokio::test]
        async fn streamed_lines_arrive_without_their_endings() {
            let (lines, mut received) = mpsc::channel(16);
            let spec = ProcessSpec::new(
                "/bin/sh",
                ["-c", "printf 'one\\r\\ntwo\\nthree'; printf 'oops\\n' >&2"],
                LONG,
            );
            let output = run(spec, Output::Stream(lines), CancellationToken::new())
                .await
                .unwrap();
            assert!(output.success() && output.stdout.is_empty());
            let mut all = Vec::new();
            while let Some(line) = received.recv().await {
                all.push(line);
            }
            let of = |stream| -> Vec<Vec<u8>> {
                all.iter()
                    .filter(|line| line.stream == stream)
                    .map(|line| line.bytes.clone())
                    .collect()
            };
            assert_eq!(
                of(Stream::Stdout),
                [b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]
            );
            assert_eq!(of(Stream::Stderr), [b"oops".to_vec()]);
        }

        #[tokio::test]
        async fn a_process_that_ignores_terminate_is_killed_after_the_grace() {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            let mut spec =
                with_pid_file("trap '' TERM; echo $$ > \"$1\"; exec sleep 30", &pid_file);
            spec.kill_grace = Duration::from_millis(500);
            let token = CancellationToken::new();
            let task = tokio::spawn(run(spec, capture(), token.clone()));
            let pid = read_pid(&pid_file).await;
            let started = Instant::now();
            token.cancel();
            let error = task.await.unwrap().unwrap_err();
            assert!(matches!(error, RunError::Cancelled), "{error:?}");
            assert!(
                started.elapsed() >= Duration::from_millis(500),
                "killed before the grace ended"
            );
            assert!(!is_running(&pid));
        }

        #[tokio::test]
        async fn stopping_reaches_what_the_process_started() {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            let spec = with_pid_file("sleep 30 & echo $! > \"$1\"; wait", &pid_file);
            let token = CancellationToken::new();
            let task = tokio::spawn(run(spec, capture(), token.clone()));
            let child = read_pid(&pid_file).await;
            token.cancel();
            assert!(matches!(task.await.unwrap(), Err(RunError::Cancelled)));
            wait_until_gone(&child).await;
        }

        #[tokio::test]
        async fn dropping_the_run_stops_the_process() {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            let spec = with_pid_file("echo $$ > \"$1\"; exec sleep 30", &pid_file);
            let task = tokio::spawn(run(spec, capture(), CancellationToken::new()));
            let pid = read_pid(&pid_file).await;
            task.abort();
            wait_until_gone(&pid).await;
        }

        #[tokio::test]
        async fn a_program_left_holding_the_pipes_does_not_hold_up_the_result() {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            let spec = with_pid_file("sleep 30 & echo $! > \"$1\"; printf done", &pid_file);
            let started = Instant::now();
            let output = run(spec, capture(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(output.code, Some(0));
            assert_eq!(output.stdout, b"done");
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "waited for the background sleep"
            );
            let left = read_pid(&pid_file).await;
            let _ = std::process::Command::new("kill").arg(&left).status();
        }

        /// Linux refuses to run a file that is open for writing ("text file busy").
        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn a_program_still_open_for_writing_starts_once_it_is_closed() {
            use std::os::unix::fs::PermissionsExt;

            let dir = tempfile::tempdir().unwrap();
            let program = dir.path().join("busy.sh");
            std::fs::write(&program, "#!/bin/sh\nprintf ran\n").unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
            let writer = std::fs::OpenOptions::new()
                .append(true)
                .open(&program)
                .unwrap();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                drop(writer);
            });
            let spec = ProcessSpec::new(&program, Vec::<OsString>::new(), LONG);
            let output = run(spec, capture(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(output.stdout, b"ran");
        }
    }
}
