mod commands;
mod events;
mod menu;
mod state;

use skopos_core::app_core::AppCore;
use skopos_core::error::IpcError;
use skopos_core::paths::AppPaths;
use state::AppState;
use tauri::webview::PageLoadEvent;
use tauri::{Context, Manager, RunEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;

const LOG_FILTER_ENV: &str = "SKOPOS_LOG";
const KEPT_LOG_FILES: usize = 7;

/// The guard flushes buffered lines when dropped. Without a usable log
/// directory the app still runs, without a log file.
fn init_logging(paths: &AppPaths) -> Option<WorkerGuard> {
    // The appender lists the directory for pruning before it would create it.
    let appender = std::fs::create_dir_all(&paths.logs)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            RollingFileAppender::builder()
                .rotation(Rotation::DAILY)
                .filename_prefix("skopos")
                .filename_suffix("log")
                .max_log_files(KEPT_LOG_FILES)
                .build(&paths.logs)
                .map_err(|e| e.to_string())
        });
    let appender = match appender {
        Ok(appender) => appender,
        Err(e) => {
            eprintln!("cannot log to {}: {e}", paths.logs.display());
            return None;
        }
    };
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env(LOG_FILTER_ENV).unwrap_or_else(|_| EnvFilter::new("info"));
    let installed = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .try_init();
    if let Err(e) = installed {
        eprintln!("cannot install the logger: {e}");
    }
    Some(guard)
}

fn report_failure(message: &impl std::fmt::Display) {
    tracing::error!("skopos failed to start: {message}");
    eprintln!("skopos failed to start: {message}");
}

pub fn run(shell_env_warning: Option<String>) {
    let context = tauri::generate_context!();
    let paths = AppPaths::resolve();
    let log_guard = paths.as_ref().ok().and_then(init_logging);
    if let Some(warning) = shell_env_warning {
        tracing::warn!("{warning}");
    }
    tracing::info!("starting skopos {}", skopos_core::VERSION);
    let started = paths.and_then(|paths| tauri::async_runtime::block_on(AppCore::start(paths)));
    match started {
        Ok(core) => run_app(core, log_guard, context),
        Err(err) => {
            report_failure(&err);
            drop(log_guard);
            show_startup_error(&err, context);
        }
    }
}

fn run_app(core: AppCore, mut log_guard: Option<WorkerGuard>, context: Context<Wry>) {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let forwarded = core.clone();
    let built = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState { core: core.clone() })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::catalog::catalog_list,
            commands::catalog::catalog_warnings,
            commands::catalog::catalog_add_pasted,
            commands::catalog::catalog_remove_pasted,
            commands::cluster::cluster_connect,
            commands::cluster::cluster_disconnect,
            commands::cluster::cluster_state,
            commands::cluster::cluster_log,
            commands::actions::workload_scale,
            commands::actions::pod_force_delete,
            commands::actions::resource_force_finalize,
            commands::actions::job_set_suspend,
            commands::actions::ingress_class_set_default,
            commands::actions::service_account_kubeconfig_save,
            commands::actions::workload_restart,
            commands::actions::pod_evict,
            commands::actions::cronjob_trigger,
            commands::actions::cronjob_set_suspend,
            commands::actions::node_set_unschedulable,
            commands::actions::node_drain_start,
            commands::actions::node_drain_cancel,
            commands::actions::secret_reveal,
            commands::actions::secret_update,
            commands::actions::configmap_update,
            commands::argocd::argocd_sync,
            commands::argocd::argocd_rollback,
            commands::argocd::argocd_terminate,
            commands::argocd::argocd_refresh,
            commands::argocd::argocd_delete,
            commands::logs::logs_start,
            commands::logs::logs_stop,
            commands::logs::logs_download,
            commands::portforward::portforward_list,
            commands::portforward::portforward_add,
            commands::portforward::portforward_start,
            commands::portforward::portforward_stop,
            commands::portforward::portforward_remove,
            commands::portforward::open_external,
            commands::sessions::terminal_start,
            commands::sessions::pod_exec_start,
            commands::sessions::pod_attach_start,
            commands::sessions::node_shell_start,
            commands::sessions::session_write,
            commands::sessions::session_resize,
            commands::sessions::session_ack,
            commands::sessions::session_stop,
            commands::resources::resources_discover,
            commands::resources::resources_names,
            commands::resources::resources_subscribe,
            commands::resources::resources_unsubscribe,
            commands::graph::resource_graph_subscribe,
            commands::graph::resource_graph_unsubscribe,
            commands::resources::resources_list,
            commands::resources::resource_get,
            commands::resources::resource_get_yaml,
            commands::resources::resource_replace,
            commands::resources::resource_apply,
            commands::resources::resource_delete,
            commands::resources::resource_events,
            commands::resources::ui_state_get,
            commands::resources::ui_state_set,
            commands::settings::cluster_settings_get,
            commands::settings::cluster_settings_set,
            commands::settings::hotbar_get,
            commands::settings::hotbar_set,
            commands::settings::prefs_get,
            commands::settings::prefs_set,
            commands::tools::tools_status,
            commands::tools::tools_download,
            commands::tools::tools_download_cancel,
            commands::helm::helm_version,
            commands::helm::helm_repo_list,
            commands::helm::helm_repo_add,
            commands::helm::helm_repo_remove,
            commands::helm::helm_repo_update,
            commands::helm::helm_chart_search,
            commands::helm::helm_chart_versions,
            commands::helm::helm_chart_readme,
            commands::helm::helm_chart_values,
            commands::helm::helm_release_list,
            commands::helm::helm_release_get,
            commands::helm::helm_release_values,
            commands::helm::helm_release_history,
            commands::helm::helm_install_preview,
            commands::helm::helm_upgrade_preview,
            commands::helm::helm_install_start,
            commands::helm::helm_upgrade_start,
            commands::helm::helm_rollback_start,
            commands::helm::helm_uninstall_start,
            commands::metrics::metrics_provider,
            commands::metrics::metrics_query,
            commands::metrics::metrics_usage,
        ])
        .setup(move |app| {
            events::spawn_forwarder(app.handle().clone(), forwarded);
            #[cfg(target_os = "macos")]
            menu::install(app.handle())?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            let state = webview.state::<AppState>();
            match payload.event() {
                // The one window is replacing its page, and the new one cannot know
                // the old one's drains or sessions. Route changes use the hash, so they
                // load nothing. Port-forwards go on: the new page lists them.
                // No automated test reaches this hook. The core's `sessions_stop_all`
                // and `node_drain_cancel_all` have their own tests.
                PageLoadEvent::Started => {
                    state.core.node_drain_cancel_all();
                    state.core.sessions_stop_all();
                }
                PageLoadEvent::Finished => {
                    events::send_startup_warnings(webview.app_handle(), &state.core);
                }
            }
        })
        .build(context);
    let app = match built {
        Ok(app) => app,
        Err(err) => {
            report_failure(&err);
            drop(log_guard);
            std::process::exit(1);
        }
    };
    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            tauri::async_runtime::block_on(core.shutdown());
            log_guard.take();
        }
    });
}

/// Runs a windowless app that only shows the error, then exits with code 1.
fn show_startup_error(err: &IpcError, mut context: Context<Wry>) -> ! {
    context.config_mut().app.windows.clear();
    let message = err.to_string();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            app.dialog()
                .message(message)
                .title("SkoposIDE could not start")
                .kind(MessageDialogKind::Error)
                .show(move |_| handle.exit(1));
            Ok(())
        })
        .run(context);
    if let Err(e) = result {
        eprintln!("cannot show the error dialog: {e}");
    }
    std::process::exit(1);
}

#[cfg(test)]
mod capability_tests {
    #[test]
    fn webview_has_no_opener_permission() {
        let raw = include_str!("../capabilities/default.json");
        assert!(
            !raw.contains("opener"),
            "the webview must not hold an opener permission (spec 5.5)"
        );
    }
}

#[cfg(test)]
mod bundle_tests {
    use std::path::Path;

    /// Spec C §8.4: the notices and the license are installed with the app.
    #[test]
    fn notices_and_license_are_installed_with_the_app() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let resources = &config["bundle"]["resources"];
        assert_eq!(
            resources["../../THIRD_PARTY_NOTICES.md"],
            "THIRD_PARTY_NOTICES.md"
        );
        assert_eq!(resources["../../LICENSE"], "LICENSE");
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        for source in ["../../THIRD_PARTY_NOTICES.md", "../../LICENSE"] {
            assert!(crate_dir.join(source).is_file(), "{source} is missing");
        }
    }
}
