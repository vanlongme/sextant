//! Repositories (F15). helm keeps the list in its own config, so it matches the user's CLI.

use std::ffi::OsString;
use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::{args, check_name, flag, parse_json, succeeded, READ_TIMEOUT};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::process::ProcessOutput;
use crate::resources::invalid;

/// `helm repo update` fetches every index.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRepo {
    pub name: String,
    pub url: String,
}

/// What `helm_repo_add` takes. The password reaches helm on stdin, never as an argument.
#[derive(Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRepoAdd {
    pub name: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl fmt::Debug for HelmRepoAdd {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HelmRepoAdd")
            .field("name", &self.name)
            .field("url", &self.url)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<hidden>"))
            .finish()
    }
}

/// `helm repo list -o json`. Before 3.22, helm failed with "no repositories to show"
/// when there were none.
pub(crate) fn parse_repo_list(output: ProcessOutput) -> CoreResult<Vec<HelmRepo>> {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.success() && stderr.contains("no repositories to show") {
        return Ok(Vec::new());
    }
    let stdout = succeeded(output)?;
    if stdout.trim_ascii().is_empty() {
        return Ok(Vec::new());
    }
    parse_json("repo list", &stdout)
}

fn check_repo_url(text: &str) -> CoreResult<()> {
    match url::Url::parse(text) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.has_host() => Ok(()),
        _ => Err(invalid("the repo URL must start with http:// or https://")),
    }
}

/// An empty form field sends "", which counts as not given.
fn given(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

impl AppCore {
    pub async fn helm_repo_list(&self) -> CoreResult<Vec<HelmRepo>> {
        let helm = self.helm_binary().await?;
        let call = args(&["repo", "list", "--output=json"]);
        let output = self
            .helm_output(&helm, call, READ_TIMEOUT, None, CancellationToken::new())
            .await?;
        parse_repo_list(output)
    }

    /// A repo of that name is a `Conflict`, also when helm skips one with the same URL.
    pub async fn helm_repo_add(&self, repo: HelmRepoAdd) -> CoreResult<()> {
        check_name("repo", &repo.name)?;
        check_repo_url(&repo.url)?;
        let mut call = args(&["repo", "add", repo.name.as_str(), repo.url.as_str()]);
        let stdin = match (given(repo.username), given(repo.password)) {
            (Some(username), Some(password)) => {
                call.push(flag("username", username));
                call.push("--password-stdin".into());
                Some(password.into_bytes())
            }
            (None, None) => None,
            _ => return Err(invalid("give both a username and a password, or neither")),
        };
        let helm = self.helm_binary().await?;
        let output = self
            .helm_output(&helm, call, READ_TIMEOUT, stdin, CancellationToken::new())
            .await?;
        let stdout = succeeded(output)?;
        if String::from_utf8_lossy(&stdout).contains("already exists with the same configuration") {
            return Err(IpcError::new(
                ErrorCode::Conflict,
                format!("a repo named {:?} already exists", repo.name),
            ));
        }
        Ok(())
    }

    pub async fn helm_repo_remove(&self, name: &str) -> CoreResult<()> {
        check_name("repo", name)?;
        let helm = self.helm_binary().await?;
        self.helm_read(&helm, args(&["repo", "remove", name]))
            .await?;
        Ok(())
    }

    /// `None` updates every repo. With no repo at all there is nothing to update, which
    /// is not an error.
    pub async fn helm_repo_update(&self, names: Option<Vec<String>>) -> CoreResult<()> {
        let mut call = args(&["repo", "update"]);
        if let Some(names) = &names {
            if names.is_empty() {
                return Ok(());
            }
            for name in names {
                check_name("repo", name)?;
                call.push(OsString::from(name));
            }
        }
        let helm = self.helm_binary().await?;
        let output = self
            .helm_output(&helm, call, UPDATE_TIMEOUT, None, CancellationToken::new())
            .await?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        if names.is_none()
            && !output.success()
            && stderr.contains("You must add one before updating")
        {
            return Ok(());
        }
        succeeded(output).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(code: i32, stdout: &str, stderr: &str) -> ProcessOutput {
        ProcessOutput {
            code: Some(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
            ..ProcessOutput::default()
        }
    }

    #[test]
    fn the_repo_list_reads_json_and_the_old_empty_answers() {
        let fixture = HelmRepo {
            name: "fixture".into(),
            url: "http://127.0.0.1:18765".into(),
        };
        let listed = parse_repo_list(output(
            0,
            r#"[{"name":"fixture","url":"http://127.0.0.1:18765"}]"#,
            "",
        ));
        assert_eq!(listed.unwrap(), [fixture]);
        assert!(parse_repo_list(output(0, "[]\n", "")).unwrap().is_empty());
        assert!(parse_repo_list(output(0, "", "")).unwrap().is_empty());
        let old = output(1, "", "Error: no repositories to show\n");
        assert!(parse_repo_list(old).unwrap().is_empty());
        let broken = parse_repo_list(output(0, "{", "")).unwrap_err();
        assert_eq!(broken.code, ErrorCode::Internal);
    }

    #[test]
    fn repo_urls_must_be_http_or_https() {
        check_repo_url("https://charts.example.test/stable").unwrap();
        check_repo_url("http://127.0.0.1:18765").unwrap();
        for bad in [
            "",
            "charts.example.test",
            "oci://registry.example.test/x",
            "file:///tmp/x",
            "-x",
        ] {
            assert_eq!(
                check_repo_url(bad).unwrap_err().code,
                ErrorCode::InvalidInput,
                "{bad}"
            );
        }
    }

    #[test]
    fn a_repo_add_request_never_prints_its_password() {
        let request = HelmRepoAdd {
            name: "fixture".into(),
            url: "http://127.0.0.1:1".into(),
            username: Some("u".into()),
            password: Some("s3cret".into()),
        };
        let printed = format!("{request:?}");
        assert!(!printed.contains("s3cret"), "{printed}");
        assert!(printed.contains("fixture"), "{printed}");
    }
}
