use std::process::Command;

/// Runs git in the crate's folder and returns its trimmed output, or "" when git
/// fails (a source archive has no repository).
fn git(args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| text.trim().to_owned())
        .unwrap_or_default()
}

fn main() {
    let commit = git(&["rev-parse", "--short=7", "HEAD"]);
    let date = if commit.is_empty() {
        String::new()
    } else {
        git(&["log", "-1", "--format=%cs"])
    };
    println!("cargo:rustc-env=SKOPOS_COMMIT={commit}");
    println!("cargo:rustc-env=SKOPOS_COMMIT_DATE={date}");
    // A commit or a checkout writes HEAD's log, which reruns this script.
    let head_log = git(&["rev-parse", "--git-path", "logs/HEAD"]);
    if !head_log.is_empty() {
        println!("cargo:rerun-if-changed={head_log}");
    }

    let pattern = if std::env::var("CARGO_FEATURE_E2E").is_ok() {
        "./capabilities*/**/*"
    } else {
        "./capabilities/**/*"
    };
    let attrs = tauri_build::Attributes::new().capabilities_path_pattern(pattern);
    tauri_build::try_build(attrs).expect("tauri build failed");
}
