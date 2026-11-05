#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sextant_core::shell_env::apply_login_shell_env();
    sextant_app_lib::run()
}
