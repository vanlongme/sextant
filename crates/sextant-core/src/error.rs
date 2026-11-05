use std::error::Error;
use std::process::ExitStatus;
use std::sync::LazyLock;

use kube::client::AuthError;
use regex::{Captures, Regex};
use serde::Serialize;
use ts_rs::TS;

const MAX_TEXT_CHARS: usize = 2000;
const STDERR_LIMIT: usize = 500;
const REDACTED: &str = "[redacted]";
const UNREADABLE_RESPONSE: &str = "the API server sent a response that could not be read";

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("the sanitizer patterns are valid")
}

// The block may be cut short, so the end marker is optional.
static PEM_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?s)-----BEGIN [^-]*-----.*?(?:-----END [^-]*-----|\z)"));
static BEARER_VALUE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r#"(?i)\b(bearer)\s+("[^"]*"|\S+)"#));
// No word boundary before the key, so `bearerToken` and `clientSecret` count too.
// The value is one of: an escaped quoted string, a quoted string, a bare word.
// A quoted string may be cut short, and then it runs to the end of the text.
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r#"(?is)(access_token|id_token|refresh_token|token|password|passwd|secret|client-key-data|client-certificate-data|api-key|apikey)([\\"']*\s*[:=]\s*)(\\"(?:[^\\]|\\[^"])*(?:\\"|\z)|"(?:[^"\\]|\\.)*(?:"|\z)|'[^']*(?:'|\z)|\S+)"#,
    )
});
static JWT: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"));
// A proxy URL from a kubeconfig reaches `kube`'s error text with its password.
static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| pattern(r"://[^/\s@]+@"));

/// Removes what looks like a credential and limits the length. All `IpcError`
/// text and connection log lines pass through here.
pub fn sanitize_text(input: &str) -> String {
    let text = PEM_BLOCK.replace_all(input, REDACTED);
    let text = BEARER_VALUE.replace_all(&text, |caps: &Captures| {
        // "bearer token" in a sentence names the thing rather than giving its value.
        let word = caps[2].trim_end_matches(|c: char| !c.is_alphanumeric());
        if word.eq_ignore_ascii_case("token") {
            caps[0].to_owned()
        } else {
            format!("{} {REDACTED}", &caps[1])
        }
    });
    let text = KEY_VALUE.replace_all(&text, format!("${{1}}${{2}}{REDACTED}").as_str());
    let text = JWT.replace_all(&text, REDACTED);
    let text = URL_USERINFO.replace_all(&text, format!("://{REDACTED}@").as_str());
    truncate(&text)
}

fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_TEXT_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

/// The nearest error of type `T` in `err`'s source chain, `err` included.
fn find_in_chain<'a, T: Error + 'static>(err: &'a (dyn Error + 'static)) -> Option<&'a T> {
    let mut current = Some(err);
    while let Some(error) = current {
        if let Some(found) = error.downcast_ref::<T>() {
            return Some(found);
        }
        current = error.source();
    }
    None
}

pub(crate) fn find_auth_error<'a>(err: &'a (dyn Error + 'static)) -> Option<&'a AuthError> {
    find_in_chain(err)
}

/// The program in `cmd`, which has one of two forms. An exec plugin gives the
/// `Debug` form of a `Command`: `env -u A B="value" "/path/program" "arg"`. The gcp
/// auth provider gives `program args` as written in the kubeconfig, where an
/// argument may be quoted. Only the environment prefix is skipped, because whatever
/// follows the program is an argument.
fn program_token(cmd: &str) -> &str {
    let (first, rest) = next_token(cmd.trim_start());
    if first != "env" {
        return skip_assignments(first, rest);
    }
    let (mut token, mut rest) = next_token(rest);
    loop {
        match token {
            "-i" => (token, rest) = next_token(rest),
            "-u" => {
                let (_name, after_name) = next_token(rest);
                (token, rest) = next_token(after_name);
            }
            _ => break,
        }
    }
    let program = skip_assignments(token, rest);
    // The `Debug` form always quotes its program, so otherwise `env` is the program.
    if program.starts_with('"') {
        program
    } else {
        first
    }
}

fn skip_assignments<'a>(mut token: &'a str, mut rest: &'a str) -> &'a str {
    while is_env_assignment(token) {
        (token, rest) = next_token(rest);
    }
    token
}

/// `NAME=value`. A path can hold `=` too, as in `/opt/a=b/program`.
fn is_env_assignment(token: &str) -> bool {
    token
        .split_once('=')
        .is_some_and(|(name, _)| !name.is_empty() && !name.contains(['"', '/', '\\']))
}

/// The first token of `text`, and what follows it with leading space removed.
fn next_token(text: &str) -> (&str, &str) {
    let (token, tail) = text.split_at(token_end(text));
    (token, tail.trim_start())
}

/// The end of the first token, where a space in double quotes does not end it.
fn token_end(text: &str) -> usize {
    let mut quoted = false;
    let mut escaped = false;
    for (index, c) in text.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => return index,
            _ => {}
        }
    }
    text.len()
}

fn plugin_name(cmd: &str) -> &str {
    program_token(cmd)
        .trim_matches('"')
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("unknown")
}

/// `AuthExecRun`'s own text holds the plugin's arguments, environment and stdout,
/// and its stdout is where the credential is.
fn exec_run_message(cmd: &str, status: ExitStatus) -> String {
    let status = status
        .code()
        .map_or_else(|| status.to_string(), |code| code.to_string());
    format!(
        "auth plugin \"{}\" failed with status {status}",
        plugin_name(cmd)
    )
}

/// `Display` of an error from any depth of `kube`'s stack, with its causes, because
/// the top level is often just "client error (Connect)". Text that can quote plugin
/// output or a response body is replaced first, since every wrapper repeats it.
pub(crate) fn error_chain(err: &(dyn Error + 'static)) -> String {
    if let Some(auth) = find_auth_error(err) {
        return auth_error_text(auth);
    }
    if find_in_chain::<serde_json::Error>(err).is_some() {
        return UNREADABLE_RESPONSE.to_owned();
    }
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text = format!("{text}: {cause_text}");
        }
        source = cause.source();
    }
    text
}

/// What an auth failure may say. `AuthError`'s `Display` is only used for the
/// variants that do not hold what a plugin printed.
pub(crate) fn auth_error_text(err: &AuthError) -> String {
    match err {
        AuthError::AuthExecRun { cmd, out, .. } => {
            let message = exec_run_message(cmd, out.status);
            match exec_run_stderr(&out.stderr) {
                Some(stderr) => {
                    let stderr: String = stderr.chars().take(STDERR_LIMIT).collect();
                    format!("{message}: {stderr}")
                }
                None => message,
            }
        }
        AuthError::AuthExecParse(_) | AuthError::AuthExecSerialize(_) => {
            "the auth plugin printed something other than an ExecCredential".to_owned()
        }
        AuthError::MalformedTokenExpirationDate(_) => {
            "the auth plugin returned a malformed token expiration date".to_owned()
        }
        _ => err.to_string(),
    }
}

/// A plugin's stderr explains its failure, once it is redacted.
fn exec_run_stderr(stderr: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    (!text.is_empty()).then(|| sanitize_text(text))
}

fn auth_ipc_error(err: &AuthError) -> IpcError {
    let code = ErrorCode::Unauthorized;
    match err {
        AuthError::AuthExecRun { cmd, out, .. } => {
            let error = IpcError::new(code, exec_run_message(cmd, out.status));
            match exec_run_stderr(&out.stderr) {
                Some(stderr) => error.with_details(stderr),
                None => error,
            }
        }
        _ => {
            let text = auth_error_text(err);
            IpcError::new(code, text.clone()).with_details(text)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub enum ErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Unreachable,
    InvalidInput,
    ToolMissing,
    Cancelled,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<String>,
}

impl IpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: sanitize_text(&message.into()),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(sanitize_text(&details.into()));
        self
    }
}

impl From<kube::Error> for IpcError {
    fn from(err: kube::Error) -> Self {
        match &err {
            kube::Error::Api(status) => {
                let code = match status.code {
                    401 => ErrorCode::Unauthorized,
                    403 => ErrorCode::Forbidden,
                    404 => ErrorCode::NotFound,
                    409 => ErrorCode::Conflict,
                    408 | 429 | 502 | 503 | 504 => ErrorCode::Unreachable,
                    _ => ErrorCode::Internal,
                };
                let message = if status.message.is_empty() {
                    status.reason.clone()
                } else {
                    status.message.clone()
                };
                IpcError::new(code, message).with_details(format!("HTTP {}", status.code))
            }
            _ => {
                if let Some(auth) = find_auth_error(&err) {
                    return auth_ipc_error(auth);
                }
                let code = match &err {
                    kube::Error::HyperError(_)
                    | kube::Error::HttpError(_)
                    | kube::Error::Service(_)
                    | kube::Error::RustlsTls(_)
                    | kube::Error::TlsRequired => ErrorCode::Unreachable,
                    _ => ErrorCode::Internal,
                };
                if find_in_chain::<serde_json::Error>(&err).is_some() {
                    return IpcError::new(code, UNREADABLE_RESPONSE);
                }
                IpcError::new(code, err.to_string()).with_details(error_chain(&err))
            }
        }
    }
}

impl From<std::io::Error> for IpcError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match err.kind() {
            ErrorKind::NotFound => ErrorCode::NotFound,
            ErrorKind::PermissionDenied => ErrorCode::Forbidden,
            ErrorKind::ConnectionRefused
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::TimedOut
            | ErrorKind::NotConnected => ErrorCode::Unreachable,
            ErrorKind::InvalidInput | ErrorKind::InvalidData => ErrorCode::InvalidInput,
            _ => ErrorCode::Internal,
        };
        IpcError::new(code, err.to_string()).with_details(err.to_string())
    }
}

pub type CoreResult<T> = Result<T, IpcError>;

#[cfg(test)]
mod tests {
    use super::*;
    use kube::core::Status;

    fn api(code: u16, message: &str) -> kube::Error {
        kube::Error::Api(Status::failure(message, "Reason").with_code(code).boxed())
    }

    #[test]
    fn kube_api_statuses_map_to_codes() {
        for (status, code) in [
            (401, ErrorCode::Unauthorized),
            (403, ErrorCode::Forbidden),
            (404, ErrorCode::NotFound),
            (409, ErrorCode::Conflict),
            (500, ErrorCode::Internal),
        ] {
            let e: IpcError = api(status, "server said no").into();
            assert_eq!(e.code, code, "status {status}");
            assert_eq!(e.message, "server said no");
        }
    }

    #[test]
    fn io_errors_map() {
        let e: IpcError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
        assert_eq!(e.code, ErrorCode::NotFound);
    }

    #[test]
    fn serializes_camel_case() {
        let e = IpcError::new(ErrorCode::NotFound, "x").with_details("d");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "NotFound");
        assert_eq!(v["details"], "d");
    }

    #[test]
    fn sanitizer_redacts_secret_shapes() {
        let cases = [
            "Authorization: Bearer abc.def-123",
            "token=s3cr3t-value",
            "\"token\": \"s3cr3t-value\"",
            "password: hunter2value",
            "client-key-data: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
            "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----",
            "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJlLXZhbHVl",
        ];
        for case in cases {
            let out = sanitize_text(case);
            for secret in [
                "abc.def-123",
                "s3cr3t-value",
                "hunter2value",
                "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo",
                "QUJD\n",
                "eyJhbGciOiJSUzI1NiJ9",
            ] {
                assert!(
                    !out.contains(secret),
                    "{case:?} leaked {secret:?} in {out:?}"
                );
            }
            assert!(out.contains("[redacted]"), "{case:?} gave {out:?}");
        }
    }

    #[test]
    fn sanitizer_keeps_ordinary_messages_intact() {
        for msg in [
            r#"pods "web-0" is forbidden: User "alice" cannot list resource "pods" in API group "" in the namespace "default""#,
            "token expired, please run aws sso login",
            "connection refused",
            "context refers to missing cluster \"prod\"",
            "the bearer token expired",
            r#"secrets "db-password" not found"#,
        ] {
            assert_eq!(sanitize_text(msg), msg);
        }
    }

    #[test]
    fn sanitizer_truncates_long_text_on_a_char_boundary() {
        let out = sanitize_text(&"é".repeat(5000));
        assert!(out.chars().count() <= 2001);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn sanitizer_keeps_the_key_and_redacts_the_whole_value() {
        for (input, expected) in [
            ("token=abc", "token=[redacted]"),
            ("Access_Token: abc", "Access_Token: [redacted]"),
            ("bearerToken: abc", "bearerToken: [redacted]"),
            ("password: \"two words\" left", "password: [redacted] left"),
            ("password: 'two words' left", "password: [redacted] left"),
            ("password: \"never closed", "password: [redacted]"),
            (r#"{\"token\":\"a b\"}"#, r#"{\"token\":[redacted]}"#),
            ("api-key = abc", "api-key = [redacted]"),
            ("Bearer abc", "Bearer [redacted]"),
        ] {
            assert_eq!(sanitize_text(input), expected);
        }
    }

    #[test]
    fn sanitizer_redacts_an_unterminated_pem_block() {
        let out = sanitize_text("before -----BEGIN RSA PRIVATE KEY-----\nQUJD\nREVG");
        assert_eq!(out, "before [redacted]");
    }

    #[test]
    fn sanitizer_redacts_a_password_in_a_url() {
        let out = sanitize_text("proxy http://user:hunter2@proxy.example:3128/ refused");
        assert_eq!(out, "proxy http://[redacted]@proxy.example:3128/ refused");
    }

    #[test]
    fn sanitizing_twice_changes_nothing() {
        for text in [
            "token=abc and Bearer def".to_owned(),
            "é".repeat(5000),
            "http://user:hunter2@proxy.example/".to_owned(),
        ] {
            let once = sanitize_text(&text);
            assert_eq!(sanitize_text(&once), once);
        }
    }

    #[test]
    fn ipc_error_constructors_sanitize_message_and_details() {
        let e = IpcError::new(ErrorCode::Internal, "token=s3cr3t-value")
            .with_details("password: hunter2value");
        let json = serde_json::to_string(&e).unwrap();
        assert!(
            !json.contains("s3cr3t-value") && !json.contains("hunter2value"),
            "{json}"
        );
    }

    #[cfg(unix)]
    fn exec_run_error(cmd: &str) -> AuthError {
        use std::process::{Command, Output};
        AuthError::AuthExecRun {
            cmd: cmd.to_owned(),
            out: Box::new(Output {
                status: Command::new("false").status().unwrap(),
                stdout: b"{\"token\":\"S3CRET-STDOUT\"}".to_vec(),
                stderr: b"Authorization: Bearer S3CRET-STDERR\nplease run login".to_vec(),
            }),
        }
    }

    #[cfg(unix)]
    fn assert_exec_run_is_safe(e: &IpcError) {
        assert_eq!(e.code, ErrorCode::Unauthorized);
        let json = serde_json::to_string(e).unwrap();
        assert!(json.contains("auth-plugin"), "{json}");
        assert!(json.contains("please run login"), "{json}");
        for secret in ["S3CRET-ARG", "S3CRET-ENV", "S3CRET-STDOUT", "S3CRET-STDERR"] {
            assert!(!json.contains(secret), "leaked {secret} in {json}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn auth_exec_run_never_exposes_stdout_and_names_only_the_plugin() {
        let cmd = "/opt/tools/auth-plugin --secret-arg S3CRET-ARG";
        let e: IpcError = kube::Error::Auth(exec_run_error(cmd)).into();
        assert_exec_run_is_safe(&e);
        assert_eq!(
            e.message,
            "auth plugin \"auth-plugin\" failed with status 1"
        );
    }

    /// `kube` passes the `Debug` form of its `Command`, which starts with the
    /// environment it changed, values included.
    #[cfg(unix)]
    #[test]
    fn auth_exec_run_names_the_plugin_from_a_command_debug_form() {
        let cmd = r#"env -u DROPPED API_KEY="S3CRET-ENV \"a b" "/opt/my tools/auth-plugin" "--secret-arg" "S3CRET-ARG""#;
        let e: IpcError = kube::Error::Auth(exec_run_error(cmd)).into();
        assert_exec_run_is_safe(&e);
        assert_eq!(
            e.message,
            "auth plugin \"auth-plugin\" failed with status 1"
        );
    }

    /// `kube`'s gcp auth provider passes `{cmd-path} {cmd-args}` as written in the
    /// kubeconfig, so the program is unquoted while an argument may be quoted.
    #[cfg(unix)]
    #[test]
    fn auth_exec_run_names_the_plugin_when_only_an_argument_is_quoted() {
        let cmd = r#"/opt/tools/auth-plugin --secret-arg "S3CRET-ARG""#;
        let e: IpcError = kube::Error::Auth(exec_run_error(cmd)).into();
        assert_exec_run_is_safe(&e);
        assert_eq!(
            e.message,
            "auth plugin \"auth-plugin\" failed with status 1"
        );
    }

    #[test]
    fn plugin_name_is_never_taken_from_arguments_or_environment() {
        for (cmd, expected) in [
            (r#"auth-plugin "S3CRET-ARG""#, "auth-plugin"),
            ("/opt/a=b/auth-plugin --key=S3CRET-ARG", "auth-plugin"),
            (r#""/usr/bin/env" "S3CRET-ARG""#, "env"),
            (
                r#"env -i A="S3CRET-ENV" "/opt/auth-plugin" "S3CRET-ARG""#,
                "auth-plugin",
            ),
            (
                r#"env -u ONE -u TWO "/opt/auth-plugin" "S3CRET-ARG""#,
                "auth-plugin",
            ),
            (
                r#"A="S3CRET-ENV \"x y" "/opt/auth-plugin" "S3CRET-ARG""#,
                "auth-plugin",
            ),
            // Only the `Debug` form quotes its program, so here `env` is the program.
            ("env S3CRET-ARG", "env"),
            ("env --secret-arg S3CRET-ARG", "env"),
            (r#"A="S3CRET-ENV""#, "unknown"),
            ("env -u", "env"),
            ("", "unknown"),
        ] {
            assert_eq!(plugin_name(cmd), expected, "{cmd}");
        }
    }

    #[test]
    fn plugin_name_reads_the_debug_form_of_a_real_command() {
        use std::process::Command;
        let mut changed = Command::new("/opt/my tools/auth-plugin");
        changed
            .arg("S3CRET-ARG")
            .env("API_KEY", "S3CRET-ENV \"a b")
            .env_remove("DROPPED");
        let mut cleared = Command::new("/opt/my tools/auth-plugin");
        cleared
            .arg("S3CRET-ARG")
            .env_clear()
            .env("API_KEY", "S3CRET-ENV");
        for command in [changed, cleared] {
            let cmd = format!("{command:?}");
            assert_eq!(plugin_name(&cmd), "auth-plugin", "{cmd}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn auth_exec_run_inside_a_service_error_is_recognised() {
        let cmd = "/opt/tools/auth-plugin --secret-arg S3CRET-ARG";
        let e: IpcError = kube::Error::Service(Box::new(exec_run_error(cmd))).into();
        assert_exec_run_is_safe(&e);
    }

    #[test]
    fn unreadable_api_responses_do_not_quote_their_content() {
        let source = serde_json::from_str::<u32>("\"S3CRET-BODY\"").unwrap_err();
        let e: IpcError = kube::Error::SerdeError(source).into();
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("S3CRET-BODY"), "{json}");
    }

    #[test]
    fn proxy_errors_do_not_quote_a_password() {
        let e: IpcError = kube::Error::ProxyProtocolUnsupported {
            proxy_url: Box::new("ftp://user:hunter2@proxy.example/".parse().unwrap()),
        }
        .into();
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("hunter2"), "{json}");
    }

    #[test]
    fn details_use_display_rather_than_debug() {
        let io = std::io::Error::other("disk on fire");
        let e: IpcError = io.into();
        assert_eq!(e.details.as_deref(), Some("disk on fire"));
    }
}
