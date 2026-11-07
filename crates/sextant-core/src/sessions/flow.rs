//! Flow control for terminal and log sessions. Output stops being read once too much of it
//! is unacknowledged, so a flood blocks in the PTY or the socket, and neither memory nor the
//! webview's queue grows without bound.

use std::sync::{Mutex, MutexGuard, PoisonError};

use tokio::sync::watch;

/// Reading stops at this many unacknowledged bytes.
pub(crate) const PAUSE_AT: u64 = 1024 * 1024;
/// Reading resumes below this many.
pub(crate) const RESUME_BELOW: u64 = 512 * 1024;

#[derive(Debug, Default)]
struct State {
    unacked: u64,
    released: bool,
}

#[derive(Debug)]
pub(crate) struct FlowControl {
    state: Mutex<State>,
    paused: watch::Sender<bool>,
}

impl FlowControl {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
            paused: watch::Sender::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits until reading may go on. A released gate never waits.
    pub(crate) async fn ready(&self) {
        let mut paused = self.paused.subscribe();
        // `self` keeps the sender alive, so this cannot fail.
        let _ = paused.wait_for(|paused| !paused).await;
    }

    /// Counts `bytes` of output as sent.
    pub(crate) fn sent(&self, bytes: u64) {
        let mut state = self.lock();
        state.unacked = state.unacked.saturating_add(bytes);
        if !state.released && state.unacked >= PAUSE_AT {
            self.paused.send_replace(true);
        }
    }

    /// Counts `bytes` of output as written by the terminal. More than was sent counts as
    /// everything, because a confused caller must not stall the session.
    pub(crate) fn acked(&self, bytes: u64) {
        let mut state = self.lock();
        state.unacked = state.unacked.saturating_sub(bytes);
        if state.unacked < RESUME_BELOW {
            self.paused.send_replace(false);
        }
    }

    /// Stops waiting for good, for a session that is ending.
    pub(crate) fn release(&self) {
        self.lock().released = true;
        self.paused.send_replace(false);
    }

    #[cfg(test)]
    pub(crate) fn unacked(&self) -> u64 {
        self.lock().unacked
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn is_ready(flow: &FlowControl) -> bool {
        tokio::time::timeout(Duration::from_millis(50), flow.ready())
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn pauses_at_the_limit_and_not_before() {
        let flow = FlowControl::new();
        flow.sent(PAUSE_AT - 1);
        assert!(is_ready(&flow).await);
        flow.sent(1);
        assert!(!is_ready(&flow).await);
    }

    #[tokio::test]
    async fn stays_paused_until_below_the_resume_mark() {
        let flow = FlowControl::new();
        flow.sent(PAUSE_AT);
        flow.acked(PAUSE_AT - RESUME_BELOW);
        assert!(
            !is_ready(&flow).await,
            "exactly at the mark is not below it"
        );
        flow.acked(1);
        assert!(is_ready(&flow).await);
    }

    #[tokio::test]
    async fn an_ack_for_more_than_was_sent_counts_as_everything() {
        let flow = FlowControl::new();
        flow.sent(10);
        flow.acked(u64::MAX);
        assert_eq!(flow.unacked(), 0);
        assert!(is_ready(&flow).await);
    }

    #[tokio::test]
    async fn release_ends_the_wait_for_good() {
        let flow = FlowControl::new();
        flow.sent(PAUSE_AT);
        flow.release();
        assert!(is_ready(&flow).await);
        flow.sent(PAUSE_AT);
        assert!(is_ready(&flow).await);
    }
}
