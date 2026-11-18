//! Yataverse Tauri commands: local files plus device custody (`drive_call`)
//! and host capability reporting (`awai_host_info`).
//!
//! Custody backends per target:
//!
//! * Android: the existing Kotlin `DrivePlugin` (Android Keystore). Unchanged.
//! * macOS: the bounded Rust adapter in [`vault`], with the device data key
//!   in the macOS Keychain ([`keychain`]) and AES-256-GCM control-file crypto
//!   framing identical to Android. The Rust adapter performs no network
//!   access; consent and sync networking stay in the JS layer.
//! * Other desktop targets (Linux, Windows): fail closed with
//!   `desktop-adapter-unavailable`. No fake success, no partial custody.
//!
//! The interactive file picker has no faithful desktop equivalent in this
//! unit: on macOS `pick` refuses with the documented `pick-unsupported`
//! code instead of a fake success.

#[cfg(target_os = "macos")]
mod drive_files;
#[cfg(target_os = "macos")]
mod vault;
#[cfg(target_os = "macos")]
mod keychain;

#[cfg(target_os = "android")]
struct AndroidDrive(tauri::plugin::PluginHandle<tauri::DynRuntime>);

#[cfg(target_os = "macos")]
struct MacosDrive(vault::DesktopDrive<keychain::KeychainKeyProvider>);

#[tauri::command]
fn awai_host_info()->serde_json::Value { serde_json::json!({"schema":"awai.shell.host.v1","driveLocal":cfg!(target_os="android") || cfg!(target_os="macos"),"sync":false}) }
#[tauri::command]
async fn drive_call(_app:tauri::AppHandle, request:serde_json::Value)->Result<serde_json::Value,String>{
 if serde_json::to_vec(&request).map_err(|_|"invalid-request")?.len()>131072{return Err("request-limit".into())}
 let op=request.get("op").and_then(|v|v.as_str()).ok_or("invalid-operation")?;
 if !["list","mkdir","createText","pick","open","vaultStatus","vaultSession","vaultRecord","vaultInventory","vaultRead","vaultCommit","vaultEvict","vaultRestoreBegin","vaultRestoreWrite","vaultRestorePublish", "vaultWnfsInventory", "vaultWnfsCommit", "vaultWnfsRestoreBegin", "vaultWnfsRestoreAbort", "vaultWnfsRestoreWrite", "vaultWnfsRestorePublish"].contains(&op){return Err("unsupported-operation".into())}
 #[cfg(target_os="android")]{use tauri::Manager;return _app.state::<AndroidDrive>().0.run_mobile_plugin_async("execute",serde_json::json!({"payload":request.to_string()})).await.map_err(|e| { let message=e.to_string(); ["unsynced-data","recovery-required","restore-mismatch","sync-size-limit","file-busy","file-exists","invalid-name","invalid-path","storage-full","file-too-large","import-cancelled","source-size-changed","local-provider-required"].iter().find(|code|message.contains(**code)).unwrap_or(&"drive-operation-failed").to_string() });}
 #[cfg(target_os="macos")]{use tauri::Manager;return _app.state::<MacosDrive>().0.execute(op,&request);}
 #[cfg(not(any(target_os="android",target_os="macos")))]{let _ = &_app; Err("desktop-adapter-unavailable".into())}
}
#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){tauri::Builder::default().runtime(tauri_runtime_wry::Wry::default())
 .plugin(tauri::plugin::Builder::<tauri::DynRuntime,()>::new("yataverse").setup(|_app,_api|{
 #[cfg(target_os="android")]{use tauri::Manager;let h=_api.register_android_plugin("network.awai.yataverse","DrivePlugin")?;_app.manage(AndroidDrive(h));}
 #[cfg(target_os="macos")]{use tauri::Manager;let base=_app.path().app_data_dir().map_err(|_|tauri::Error::UnknownPath)?;let drive=vault::DesktopDrive::new(keychain::KeychainKeyProvider::production(),&base).map_err(|_|tauri::Error::UnknownPath)?;_app.manage(MacosDrive(drive));}
 Ok(())}).build())
 .invoke_handler(tauri::generate_handler![awai_host_info,drive_call]).run(tauri::generate_context!()).expect("Drive initialization failed");}
