fn main() {
    let pattern = if std::env::var("CARGO_FEATURE_E2E").is_ok() {
        "./capabilities*/**/*"
    } else {
        "./capabilities/**/*"
    };
    let attrs = tauri_build::Attributes::new().capabilities_path_pattern(pattern);
    tauri_build::try_build(attrs).expect("tauri build failed");
}
