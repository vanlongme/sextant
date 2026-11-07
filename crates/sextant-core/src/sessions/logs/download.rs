//! `logs_download`: the same streams as a session, written to a file instead of a channel.
//! The file appears at the given path only once everything has been written.

use std::path::Path;

use tempfile::NamedTempFile;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::mpsc;

use super::follow::StreamContext;
use super::{
    check_target, run_target, target_namespace, LogDownload, LogEndReason, LogEvent, LogLine,
    LogMarker, LogOptions, LogTarget, StreamItem, ITEM_BACKLOG,
};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::invalid;

/// A target that can name several streams needs each line to say whose it is.
fn can_have_several_streams(target: &LogTarget) -> bool {
    !matches!(
        target,
        LogTarget::Pod {
            container: Some(_),
            ..
        }
    )
}

fn format_line(line: &LogLine, labelled: bool) -> String {
    let mut text = String::with_capacity(line.text.len() + 64);
    if labelled {
        text.push_str(&format!("[{}/{}] ", line.pod, line.container));
    }
    if let Some(timestamp) = &line.timestamp {
        text.push_str(timestamp);
        text.push(' ');
    }
    text.push_str(&line.text);
    text.push('\n');
    text
}

/// One of several streams failing leaves a note where its lines would have been.
fn format_note(
    pod: &str,
    container: Option<&str>,
    marker: LogMarker,
    message: Option<&str>,
) -> Option<String> {
    (marker == LogMarker::Failed).then(|| {
        let message = message.unwrap_or("the stream failed");
        match container {
            Some(container) => format!("[{pod}/{container}] {message}\n"),
            None => format!("[{pod}] {message}\n"),
        }
    })
}

fn download_options(options: LogOptions) -> LogOptions {
    LogOptions {
        follow: false,
        tail_lines: None,
        ..options
    }
}

/// Writes items to the file until the streams end, and returns how many bytes it wrote.
async fn write_items(
    mut items: mpsc::Receiver<StreamItem>,
    file: std::fs::File,
    labelled: bool,
) -> std::io::Result<u64> {
    let mut writer = BufWriter::new(tokio::fs::File::from_std(file));
    let mut bytes = 0;
    while let Some(item) = items.recv().await {
        let text = match item {
            StreamItem::Line(line) => Some(format_line(&line, labelled)),
            StreamItem::Marker {
                pod,
                container,
                marker,
                message,
            } => format_note(&pod, container.as_deref(), marker, message.as_deref()),
        };
        if let Some(text) = text {
            writer.write_all(text.as_bytes()).await?;
            bytes += text.len() as u64;
        }
    }
    writer.flush().await?;
    writer.get_ref().sync_all().await?;
    Ok(bytes)
}

impl AppCore {
    /// Writes the logs of `target` to `dest`, ignoring `follow` and the tail limit. Stops
    /// with the other sessions, which leaves nothing at `dest`.
    pub async fn logs_download(
        &self,
        id: &ClusterId,
        target: LogTarget,
        options: LogOptions,
        dest: &Path,
    ) -> CoreResult<LogDownload> {
        check_target(&target)?;
        if !dest.is_absolute() {
            return Err(invalid("the destination path must be absolute"));
        }
        let parent = dest
            .parent()
            .ok_or_else(|| invalid("the destination path has no folder"))?;
        let client = self.cluster_client(id)?;
        let token = self.cluster_cancel_token(id)?;
        let guard = self.sessions().register(token.clone(), None);
        let temp = NamedTempFile::new_in(parent).map_err(|error| {
            // The io error quotes the folder path, which must not reach the caller.
            IpcError::new(
                IpcError::from(error).code,
                "the destination folder cannot be written",
            )
        })?;
        let (file, temp_path) = temp.into_parts();

        let labelled = can_have_several_streams(&target);
        let (items, items_rx) = mpsc::channel(ITEM_BACKLOG);
        let writer = tokio::spawn(write_items(items_rx, file, labelled));
        let context = StreamContext {
            client,
            namespace: target_namespace(&target).to_owned(),
            options: download_options(options),
            items,
            token,
            follow_replacements: true,
        };
        let last = run_target(context, target).await;
        let bytes = writer
            .await
            .map_err(|_| IpcError::new(ErrorCode::Internal, "the log writer stopped"))??;
        drop(guard);
        match last {
            LogEvent::Failed { error } => Err(error),
            LogEvent::Ended {
                reason: LogEndReason::Stopped,
            } => Err(IpcError::new(
                ErrorCode::Cancelled,
                "the download was stopped",
            )),
            _ => {
                temp_path
                    .persist(dest)
                    .map_err(|error| IpcError::from(error.error))?;
                Ok(LogDownload { bytes })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> LogLine {
        LogLine {
            pod: "p".into(),
            container: "c".into(),
            timestamp: Some("2026-01-01T00:00:00Z".into()),
            text: "hello".into(),
            truncated: false,
        }
    }

    #[test]
    fn lines_are_labelled_only_when_there_can_be_several_streams() {
        assert_eq!(format_line(&line(), false), "2026-01-01T00:00:00Z hello\n");
        assert_eq!(
            format_line(&line(), true),
            "[p/c] 2026-01-01T00:00:00Z hello\n"
        );
    }

    #[test]
    fn only_a_failed_marker_leaves_a_note() {
        assert_eq!(
            format_note("p", Some("c"), LogMarker::Failed, Some("no access")).as_deref(),
            Some("[p/c] no access\n")
        );
        assert_eq!(format_note("p", None, LogMarker::PodAdded, None), None);
    }

    #[test]
    fn the_tail_limit_and_follow_are_ignored() {
        let options = download_options(LogOptions {
            follow: true,
            previous: true,
            tail_lines: Some(5),
            since_seconds: Some(60),
        });
        assert!(!options.follow);
        assert_eq!(options.tail_lines, None);
        assert!(options.previous);
        assert_eq!(options.since_seconds, Some(60));
    }

    #[test]
    fn a_container_target_is_the_only_single_stream_one() {
        let pod = |container: Option<&str>| LogTarget::Pod {
            namespace: "n".into(),
            pod: "p".into(),
            container: container.map(str::to_owned),
        };
        assert!(!can_have_several_streams(&pod(Some("c"))));
        assert!(can_have_several_streams(&pod(None)));
    }
}
