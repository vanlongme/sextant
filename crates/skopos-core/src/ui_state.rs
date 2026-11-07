//! Small pieces of view state the UI wants kept between runs, such as column
//! widths and the last open tab, stored by key in `ui-state.json`.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::error::CoreResult;
use crate::store::{JsonStore, StoreWarning};

pub struct UiState {
    store: JsonStore<HashMap<String, Value>>,
}

impl UiState {
    pub fn open(path: PathBuf, version: u32) -> (Self, Option<StoreWarning>) {
        let (store, warning) = JsonStore::open(path, version);
        (Self { store }, warning)
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.store.get().remove(key)
    }

    pub fn set(&self, key: &str, value: Value) -> CoreResult<()> {
        self.store.update(|all| {
            all.insert(key.to_owned(), value);
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unset_key_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let (state, warning) = UiState::open(dir.path().join("ui-state.json"), 1);
        assert!(warning.is_none());
        assert_eq!(state.get("missing"), None);
    }

    #[test]
    fn set_then_get_returns_the_value() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _) = UiState::open(dir.path().join("ui-state.json"), 1);
        state.set("widths", json!({"name": 240})).unwrap();
        state.set("tab", json!("pods")).unwrap();
        assert_eq!(state.get("widths"), Some(json!({"name": 240})));
        assert_eq!(state.get("tab"), Some(json!("pods")));
    }

    #[test]
    fn values_persist_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ui-state.json");
        let (state, _) = UiState::open(path.clone(), 1);
        state.set("tab", json!(["a", 1, null])).unwrap();
        drop(state);
        let (reopened, warning) = UiState::open(path, 1);
        assert!(warning.is_none());
        assert_eq!(reopened.get("tab"), Some(json!(["a", 1, null])));
    }
}
