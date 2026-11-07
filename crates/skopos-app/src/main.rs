#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Still before the Tokio runtime starts; `run` logs the outcome once logging is up.
    let shell_env_warning = skopos_core::shell_env::apply_login_shell_env();
    skopos_app_lib::run(shell_env_warning)
}
