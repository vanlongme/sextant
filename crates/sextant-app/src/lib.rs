mod commands;
mod events;
mod state;

use sextant_core::app_core::AppCore;
use sextant_core::error::IpcError;
use sextant_core::paths::AppPaths;
use state::AppState;
use tauri::webview::PageLoadEvent;
use tauri::{Context, Manager, RunEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;

const LOG_FILTER_ENV: &str = "SEXTANT_LOG";
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
                .filename_prefix("sextant")
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
    tracing::error!("sextant failed to start: {message}");
    eprintln!("sextant failed to start: {message}");
}

pub fn run() {
    let context = tauri::generate_context!();
    let paths = AppPaths::resolve();
    let log_guard = paths.as_ref().ok().and_then(init_logging);
    tracing::info!("starting sextant {}", sextant_core::VERSION);
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState { core: core.clone() })
        .invoke_handler(tauri::generate_handler![
            commands::catalog::catalog_list,
            commands::catalog::catalog_warnings,
            commands::catalog::catalog_add_pasted,
            commands::catalog::catalog_remove_pasted,
            commands::settings::cluster_settings_get,
            commands::settings::cluster_settings_set,
            commands::settings::hotbar_get,
            commands::settings::hotbar_set,
            commands::settings::prefs_get,
            commands::settings::prefs_set,
        ])
        .setup(move |app| {
            events::spawn_forwarder(app.handle().clone(), forwarded);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let state = webview.state::<AppState>();
                events::send_startup_warnings(webview.app_handle(), &state.core);
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
                .title("Sextant could not start")
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
