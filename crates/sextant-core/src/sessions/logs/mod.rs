//! Log streaming (F10). `parse` turns bytes into lines.

mod parse;

use serde::Serialize;
use ts_rs::TS;

/// One line of a container's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub pod: String,
    pub container: String,
    /// Always requested, so the view's toggle restarts nothing.
    pub timestamp: Option<String>,
    /// ANSI codes included.
    pub text: String,
    /// The line passed 64 KiB.
    pub truncated: bool,
}
