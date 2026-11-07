//! Turning the bytes of a log stream into lines. Everything here is pure.

use k8s_openapi::jiff::Timestamp;

use super::LogLine;

/// The longest text a line keeps. Anything longer is cut and flagged.
pub(super) const LINE_LIMIT: usize = 64 * 1024;
/// Room for the timestamp in front of the text, so it does not count against the limit.
const TIMESTAMP_ROOM: usize = 64;

/// One line as it arrived, without its newline.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct RawLine {
    pub(super) bytes: Vec<u8>,
    /// More arrived than was kept.
    pub(super) overflowed: bool,
}

/// Splits chunks into lines, holding at most one line's worth of bytes however long the
/// line turns out to be.
#[derive(Debug, Default)]
pub(super) struct LineSplitter {
    partial: Vec<u8>,
    overflowed: bool,
}

impl LineSplitter {
    /// Adds a chunk and returns the lines it completes.
    pub(super) fn push(&mut self, mut chunk: &[u8]) -> Vec<RawLine> {
        let mut lines = Vec::new();
        while let Some(end) = chunk.iter().position(|byte| *byte == b'\n') {
            self.keep(&chunk[..end]);
            lines.push(self.take());
            chunk = &chunk[end + 1..];
        }
        self.keep(chunk);
        lines
    }

    /// The unfinished last line, when the stream ended without a newline.
    pub(super) fn finish(&mut self) -> Option<RawLine> {
        (!self.partial.is_empty()).then(|| self.take())
    }

    fn keep(&mut self, bytes: &[u8]) {
        let room = (LINE_LIMIT + TIMESTAMP_ROOM).saturating_sub(self.partial.len());
        let kept = bytes.len().min(room);
        self.overflowed |= kept < bytes.len();
        self.partial.extend_from_slice(&bytes[..kept]);
    }

    fn take(&mut self) -> RawLine {
        RawLine {
            bytes: std::mem::take(&mut self.partial),
            overflowed: std::mem::take(&mut self.overflowed),
        }
    }
}

/// The timestamp the API server put in front of the text, when there is one.
fn split_timestamp(bytes: &[u8]) -> (Option<String>, &[u8]) {
    let Some(space) = bytes.iter().position(|byte| *byte == b' ') else {
        return (None, bytes);
    };
    let parsed = std::str::from_utf8(&bytes[..space])
        .ok()
        .filter(|token| token.parse::<Timestamp>().is_ok());
    match parsed {
        Some(token) => (Some(token.to_owned()), &bytes[space + 1..]),
        None => (None, bytes),
    }
}

/// A `LogLine` from raw bytes: the timestamp split off, invalid UTF-8 replaced, ANSI codes
/// left alone, and text over the limit cut.
pub(super) fn parse_line(raw: &RawLine, pod: &str, container: &str) -> LogLine {
    let bytes = raw.bytes.strip_suffix(b"\r").unwrap_or(&raw.bytes);
    let (timestamp, text) = split_timestamp(bytes);
    let cut = text.len() > LINE_LIMIT;
    let kept = if cut { &text[..LINE_LIMIT] } else { text };
    let mut text = String::from_utf8_lossy(kept).into_owned();
    let truncated = raw.overflowed || cut;
    // The cut can fall inside a character, which is not a fault in the line.
    if truncated && text.ends_with(char::REPLACEMENT_CHARACTER) {
        text.pop();
    }
    LogLine {
        pod: pod.to_owned(),
        container: container.to_owned(),
        timestamp,
        text,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(text: &str) -> RawLine {
        RawLine {
            bytes: text.as_bytes().to_vec(),
            overflowed: false,
        }
    }

    #[test]
    fn splits_on_newlines_across_chunks() {
        let mut splitter = LineSplitter::default();
        assert_eq!(splitter.push(b"one\ntw"), vec![raw("one")]);
        assert_eq!(splitter.push(b"o\n"), vec![raw("two")]);
        assert_eq!(splitter.push(b"\n"), vec![raw("")]);
        assert_eq!(splitter.finish(), None);
    }

    #[test]
    fn finish_returns_an_unfinished_last_line() {
        let mut splitter = LineSplitter::default();
        assert!(splitter.push(b"no newline").is_empty());
        assert_eq!(splitter.finish(), Some(raw("no newline")));
        assert_eq!(splitter.finish(), None);
    }

    #[test]
    fn a_long_line_holds_a_bounded_amount_and_the_next_line_is_whole() {
        let mut splitter = LineSplitter::default();
        for _ in 0..4 {
            assert!(splitter.push(&vec![b'x'; LINE_LIMIT]).is_empty());
        }
        assert!(splitter.partial.len() <= LINE_LIMIT + TIMESTAMP_ROOM);
        let lines = splitter.push(b"tail\nnext\n");
        assert!(lines[0].overflowed);
        assert_eq!(lines[1], raw("next"));
    }

    #[test]
    fn the_timestamp_is_split_from_the_text() {
        let line = parse_line(
            &raw("2026-01-01T00:00:01.000000001Z hello  world"),
            "p",
            "c",
        );
        assert_eq!(
            line.timestamp.as_deref(),
            Some("2026-01-01T00:00:01.000000001Z")
        );
        assert_eq!(line.text, "hello  world");
        assert_eq!((line.pod.as_str(), line.container.as_str()), ("p", "c"));
        assert!(!line.truncated);
    }

    #[test]
    fn a_line_without_a_timestamp_keeps_all_its_text() {
        for text in ["hello world", "nospace", ""] {
            let line = parse_line(&raw(text), "p", "c");
            assert_eq!(line.timestamp, None);
            assert_eq!(line.text, text);
        }
    }

    #[test]
    fn invalid_utf8_is_replaced_and_ansi_codes_pass_through() {
        let bytes = b"2026-01-01T00:00:00Z \x1b[31mred\x1b[0m \xff".to_vec();
        let line = parse_line(
            &RawLine {
                bytes,
                overflowed: false,
            },
            "p",
            "c",
        );
        assert_eq!(line.text, "\u{1b}[31mred\u{1b}[0m \u{fffd}");
        assert!(!line.truncated);
    }

    #[test]
    fn a_trailing_carriage_return_is_dropped() {
        assert_eq!(parse_line(&raw("one\r"), "p", "c").text, "one");
    }

    #[test]
    fn text_at_the_limit_is_whole_and_over_it_is_cut_and_flagged() {
        let at_limit = format!("2026-01-01T00:00:00Z {}", "x".repeat(LINE_LIMIT));
        let line = parse_line(&raw(&at_limit), "p", "c");
        assert_eq!(line.text.len(), LINE_LIMIT);
        assert!(!line.truncated);

        let over = format!("2026-01-01T00:00:00Z {}", "x".repeat(LINE_LIMIT + 1));
        let line = parse_line(&raw(&over), "p", "c");
        assert_eq!(line.text.len(), LINE_LIMIT);
        assert!(line.truncated);
    }

    #[test]
    fn a_cut_inside_a_character_leaves_no_replacement_character() {
        let text = format!("{}é", "x".repeat(LINE_LIMIT - 1));
        let line = parse_line(&raw(&text), "p", "c");
        assert!(line.truncated);
        assert_eq!(line.text, "x".repeat(LINE_LIMIT - 1));
    }
}
