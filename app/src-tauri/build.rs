fn main() {
    // Builds installed on 16 KiB Android must align the native LOAD segments.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["awai_host_info", "drive_call"]),
        ),
    )
    .expect("Itonami build");
}
