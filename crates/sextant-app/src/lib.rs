pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("sextant failed to start: {err}");
        std::process::exit(1);
    }
}
