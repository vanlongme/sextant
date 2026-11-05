pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let result = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("sextant failed to start: {err}");
        std::process::exit(1);
    }
}
