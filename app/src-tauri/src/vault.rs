//! Device custody and bounded local I/O for the macOS desktop target.
//!
//! Rust port of `DriveVault.java` (Android). The control record
//! (`drive-vault-v1.bin`) is encrypted with AES-256-GCM under a device key
//! held by the [`VaultKeyProvider`] (the macOS Keychain on production
//! builds, an in-memory stub in tests). The framing mirrors Android exactly:
//! `12-byte IV || ciphertext` with the vault alias as AAD, so the on-disk
//! format carries no plaintext key material.
//!
//! Secret key material is never written to disk in plaintext: no key files,
//! no keys in the JSON control state, and no key material in logs or error
//! strings (every failure surfaces as a fixed error code from the Android
//! contract). In-memory secrets are wiped with [`zeroize::Zeroizing`].
//!
//! JSON shapes and error codes are identical to the Android plugin so the JS
//! layer (`app/src/sync.js`, `app/src/wnfs-sync.js`) needs no platform
//! branches. One deliberate addition: the interactive file picker has no
//! faithful desktop equivalent in this unit, so `pick` refuses with the
//! distinct, documented code `pick-unsupported` instead of a fake success.

use crate::drive_files::{self, DriveFiles};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Map, Value, json};
use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zeroize::Zeroizing;

/// Keystore alias, also used as the AES-GCM AAD. Identical to Android.
pub const ALIAS: &str = "awai.drive.vault.v1";
/// Production Keychain service holding the device data key.
pub const KEYCHAIN_SERVICE: &str = "network.awai.yataverse.vault";
/// Test-only Keychain service. Tests must never touch any other item.
#[allow(dead_code)]
pub const KEYCHAIN_TEST_SERVICE: &str = "network.awai.yataverse.vault.test";

const LEGACY_BYTES: i64 = 8 * 1024 * 1024;
const WNFS_BYTES: i64 = 32 * 1024 * 1024;
const RESERVE: u64 = 64 * 1024 * 1024;
const MAX_STATE: usize = 240_000;
const CONTROL_MIN: usize = 29;
const CONTROL_MAX: usize = 262_144;
const MAX_RECORD: usize = 16_000;
const MAX_ENTRIES: usize = 1000;
const CHUNK: usize = 65531;
const WNFS_SCHEMA: &str = "awai.drive.wnfs.v1";

/// Device key custody. Key material only ever travels in memory.
pub trait VaultKeyProvider: Send + Sync {
    fn key_exists(&self) -> Result<bool, String>;
    fn load_key(&self) -> Result<Option<[u8; 32]>, String>;
    fn store_key(&self, key: &[u8; 32]) -> Result<(), String>;
}

/// Non-persistent provider for unit tests. Never touches the Keychain.
#[allow(dead_code)]
#[derive(Default)]
pub struct MemoryKeyProvider {
    key: Mutex<Option<[u8; 32]>>,
}

impl MemoryKeyProvider {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }
}

impl VaultKeyProvider for MemoryKeyProvider {
    fn key_exists(&self) -> Result<bool, String> {
        Ok(self.key.lock().map_err(|_| "drive-operation-failed".to_string())?.is_some())
    }
    fn load_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(*self.key.lock().map_err(|_| "drive-operation-failed".to_string())?)
    }
    fn store_key(&self, key: &[u8; 32]) -> Result<(), String> {
        *self.key.lock().map_err(|_| "drive-operation-failed".to_string())? = Some(*key);
        Ok(())
    }
}

fn b64e(bytes: impl AsRef<[u8]>) -> String {
    B64.encode(bytes)
}

fn b64d(text: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    // A malformed payload is a client bug, never key material: fixed code.
    B64.decode(text)
        .map(Zeroizing::new)
        .map_err(|_| "drive-operation-failed".to_string())
}

fn is_hex64(s: &str) -> bool {
    // Full-match `[a-f0-9]{64}`: lowercase only, exactly like Android.
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn digest_id(value: &Value) -> Result<String, String> {
    match value.as_str() {
        Some(s) if is_hex64(s) => Ok(s.to_string()),
        _ => Err("invalid-root".into()),
    }
}

fn random_32() -> Result<Zeroizing<[u8; 32]>, String> {
    let mut key = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut key[..]).map_err(|_| "drive-operation-failed".to_string())?;
    Ok(key)
}

fn encrypt_control(dek: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut nonce_bytes).map_err(|_| "drive-operation-failed".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(dek).map_err(|_| "drive-operation-failed".to_string())?;
    let mut out = Vec::with_capacity(12 + plaintext.len() + 16);
    out.extend_from_slice(&nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let body = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: ALIAS.as_bytes(),
            },
        )
        .map_err(|_| "drive-operation-failed".to_string())?;
    out.extend_from_slice(&body);
    Ok(out)
}

fn decrypt_control(dek: &[u8; 32], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    if blob.len() < CONTROL_MIN || blob.len() > CONTROL_MAX {
        return Err("recovery-required".into());
    }
    let cipher = Aes256Gcm::new_from_slice(dek).map_err(|_| "drive-operation-failed".to_string())?;
    let nonce_bytes: [u8; 12] = blob[..12]
        .try_into()
        .map_err(|_| "drive-operation-failed".to_string())?;
    let nonce = Nonce::from(nonce_bytes);
    // Mirror Android: an unauthenticated control file refuses with the
    // generic failure code, never with key-dependent detail.
    let plain = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &blob[12..],
                aad: ALIAS.as_bytes(),
            },
        )
        .map_err(|_| "drive-operation-failed".to_string())?;
    Ok(Zeroizing::new(plain))
}

/// The vault: encrypted control record plus bounded cache and staging dirs.
/// All state lives under one base dir so staged publishes rename atomically.
pub struct Vault<K: VaultKeyProvider> {
    keys: K,
    control: PathBuf,
    cache: PathBuf,
    base: PathBuf,
}

impl<K: VaultKeyProvider> Vault<K> {
    pub fn new(keys: K, base: &Path) -> Result<Self, String> {
        fs::create_dir_all(base).map_err(|_| "storage-unavailable".to_string())?;
        let base = base.canonicalize().map_err(|_| "storage-unavailable".to_string())?;
        let cache = base.join("drive-local-v1");
        fs::create_dir_all(&cache).map_err(|_| "storage-unavailable".to_string())?;
        Ok(Self {
            keys,
            control: base.join("drive-vault-v1.bin"),
            cache,
            base,
        })
    }

    fn files(&self) -> Result<DriveFiles, String> {
        DriveFiles::new(&self.cache)
    }

    fn stage_legacy(&self) -> PathBuf {
        self.base.join("drive-restore-v1")
    }

    fn stage_wnfs(&self) -> PathBuf {
        self.base.join("drive-restore-wnfs")
    }

    fn load(&self) -> Result<Option<Map<String, Value>>, String> {
        if !self.control.exists() {
            return Ok(None);
        }
        let blob = fs::read(&self.control).map_err(|_| "recovery-required".to_string())?;
        if blob.len() < CONTROL_MIN || blob.len() > CONTROL_MAX {
            return Err("recovery-required".into());
        }
        let dek = match self.keys.load_key()? {
            Some(k) => Zeroizing::new(k),
            None => return Err("recovery-required".into()),
        };
        let plain = decrypt_control(&dek, &blob)?;
        let value: Value =
            serde_json::from_slice(&plain).map_err(|_| "recovery-required".to_string())?;
        match value {
            Value::Object(map) => Ok(Some(map)),
            _ => Err("recovery-required".into()),
        }
    }

    fn save(&self, value: &Map<String, Value>) -> Result<(), String> {
        let text = Value::Object(value.clone()).to_string();
        let plain = Zeroizing::new(text.into_bytes());
        if plain.len() > MAX_STATE {
            return Err("state-limit".into());
        }
        let dek = match self.keys.load_key()? {
            Some(k) => Zeroizing::new(k),
            None => return Err("recovery-required".into()),
        };
        let blob = encrypt_control(&dek, &plain)?;
        // Atomic publish through a temp file plus parent-dir fsync.
        let mut tmp = tempfile::NamedTempFile::new_in(self.control.parent().ok_or_else(|| "storage-unavailable".to_string())?)
            .map_err(|_| "storage-unavailable".to_string())?;
        tmp.write_all(&blob).map_err(|_| "storage-unavailable".to_string())?;
        tmp.as_file().sync_all().map_err(|_| "storage-unavailable".to_string())?;
        tmp.persist(&self.control).map_err(|_| "storage-unavailable".to_string())?;
        drive_files::fsync_dir(self.control.parent().ok_or_else(|| "storage-unavailable".to_string())?)?;
        Ok(())
    }

    fn inventory(&self, limit: i64) -> Result<Vec<Value>, String> {
        let d = self.files()?;
        let mut out: Vec<Value> = Vec::new();
        let mut total: i64 = 0;
        self.walk(&d, "", &mut out, &mut total, limit)?;
        Ok(out)
    }

    fn walk(
        &self,
        d: &DriveFiles,
        rel: &str,
        out: &mut Vec<Value>,
        total: &mut i64,
        limit: i64,
    ) -> Result<(), String> {
        for f in d.list(rel)? {
            if out.len() >= MAX_ENTRIES {
                return Err("entry-limit".into());
            }
            let p = d.resolve(&f.path)?;
            if f.directory {
                out.push(json!({"path": f.path, "directory": true}));
                self.walk(d, &f.path, out, total, limit)?;
            } else {
                if !p.is_file() {
                    return Err("invalid-path".into());
                }
                *total = total.saturating_add(f.bytes as i64);
                if *total > limit {
                    return Err("sync-size-limit".into());
                }
                let sha = drive_files::sha256_file(&p)?;
                out.push(json!({"path": f.path, "directory": false, "size": f.bytes, "sha256": sha}));
            }
        }
        Ok(())
    }

    fn equal_inventory(a: &[Value], b: &[Value]) -> bool {
        if a.len() != b.len() {
            return false;
        }
        for (x, y) in a.iter().zip(b.iter()) {
            let same = x.get("path") == y.get("path")
                && x.get("directory") == y.get("directory");
            if !same {
                return false;
            }
            if x.get("directory").and_then(Value::as_bool).unwrap_or(false) {
                continue;
            }
            if x.get("size") != y.get("size") || x.get("sha256") != y.get("sha256") {
                return false;
            }
        }
        true
    }

    fn same(&self, expected: &[Value]) -> Result<(), String> {
        if !Self::equal_inventory(&self.inventory(LEGACY_BYTES)?, expected) {
            return Err("unsynced-data".into());
        }
        Ok(())
    }

    fn remove_tree(&self, f: &Path) -> Result<(), String> {
        if fs::symlink_metadata(f)
            .map(|md| md.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("invalid-path".into());
        }
        if f.is_dir() {
            let children = fs::read_dir(f).map_err(|_| "storage-unavailable".to_string())?;
            for child in children {
                let child = child.map_err(|_| "storage-unavailable".to_string())?;
                self.remove_tree(&child.path())?;
            }
        }
        fs::remove_file(f)
            .or_else(|_| fs::remove_dir(f))
            .map_err(|_| "storage-unavailable".to_string())
    }

    fn no_unpublished(&self, dir: &DriveFiles) -> Result<(), String> {
        self.no_unpublished_path(dir.root())
    }

    fn no_unpublished_path(&self, dir: &Path) -> Result<(), String> {
        let children = fs::read_dir(dir).map_err(|_| "storage-unavailable".to_string())?;
        for child in children {
            let child = child.map_err(|_| "storage-unavailable".to_string())?;
            let p = child.path();
            if fs::symlink_metadata(&p)
                .map(|md| md.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err("invalid-path".into());
            }
            let name = child.file_name().to_string_lossy().into_owned();
            if name.starts_with(".pending-") && name != ".pending-writer.lock" {
                return Err("unsynced-data".into());
            }
            if p.is_dir() {
                self.no_unpublished_path(&p)?;
            }
        }
        Ok(())
    }

    fn allocated(&self, dir: &Path, limit: i64) -> Result<i64, String> {
        let mut count: i64 = 0;
        self.allocated_into(dir, &mut count, limit)
    }

    fn allocated_into(&self, dir: &Path, count: &mut i64, limit: i64) -> Result<i64, String> {
        let mut bytes: i64 = 0;
        let children = fs::read_dir(dir).map_err(|_| "storage-unavailable".to_string())?;
        for child in children {
            let child = child.map_err(|_| "storage-unavailable".to_string())?;
            let p = child.path();
            *count += 1;
            // Mirror Android: over-limit and symlink both surface entry-limit.
            if *count > MAX_ENTRIES as i64
                || fs::symlink_metadata(&p)
                    .map(|md| md.file_type().is_symlink())
                    .unwrap_or(false)
            {
                return Err("entry-limit".into());
            }
            if p.is_dir() {
                bytes = bytes.saturating_add(self.allocated_into(&p, count, limit)?);
            } else if p.is_file() {
                let len = p.metadata().map_err(|_| "storage-unavailable".to_string())?.len() as i64;
                bytes = bytes.saturating_add(len);
            } else {
                return Err("invalid-path".into());
            }
            if bytes > limit {
                return Err("sync-size-limit".into());
            }
        }
        Ok(bytes)
    }

    fn all_dirs(&self, dir: &Path) -> Result<Vec<PathBuf>, String> {
        let mut out = Vec::new();
        let children = fs::read_dir(dir).map_err(|_| "storage-unavailable".to_string())?;
        for child in children {
            let child = child.map_err(|_| "storage-unavailable".to_string())?;
            let p = child.path();
            if p.is_dir() {
                out.extend(self.all_dirs(&p)?);
            }
        }
        out.push(dir.to_path_buf());
        Ok(out)
    }

    fn wnfs_head<'a>(control: &'a Map<String, Value>) -> Result<&'a Map<String, Value>, String> {
        match control.get("wnfs").and_then(Value::as_object) {
            Some(head) if head.get("schema").and_then(Value::as_str) == Some(WNFS_SCHEMA) => Ok(head),
            _ => Err("recovery-required".into()),
        }
    }

    fn legacy_head(control: &Map<String, Value>) -> Result<(), String> {
        if control.contains_key("pack") && control.contains_key("entries") {
            Ok(())
        } else {
            Err("recovery-required".into())
        }
    }

    fn req_str<'a>(q: &'a Value, field: &str) -> Result<&'a str, String> {
        q.get(field).and_then(Value::as_str).ok_or_else(|| "drive-operation-failed".to_string())
    }

    fn req_i64(q: &Value, field: &str) -> Result<i64, String> {
        q.get(field).and_then(Value::as_i64).ok_or_else(|| "drive-operation-failed".to_string())
    }

    fn req_usize(q: &Value, field: &str) -> Result<usize, String> {
        q.get(field).and_then(Value::as_u64).and_then(|v| usize::try_from(v).ok()).ok_or_else(|| "drive-operation-failed".to_string())
    }

    fn req_entries(q: &Value) -> Result<Vec<Value>, String> {
        match q.get("entries").and_then(Value::as_array) {
            Some(a) => Ok(a.clone()),
            None => Err("drive-operation-failed".into()),
        }
    }

    fn op_session(&self, q: &Value) -> Result<Value, String> {
        let loaded = self.load()?;
        if let Some(v) = loaded {
            let mut r = Value::Object(v);
            r["initialized"] = json!(true);
            return Ok(r);
        }
        let initialize = q.get("initialize").and_then(Value::as_bool).unwrap_or(false);
        if !initialize {
            return Ok(json!({"initialized": false}));
        }
        // No automatic new-identity fallback in an initialized namespace.
        if self.keys.key_exists()? {
            return Err("recovery-required".into());
        }
        let dek = random_32()?;
        self.keys.store_key(&dek)?;
        let secret = random_32()?;
        let v: Map<String, Value> = [("secret".to_string(), json!(b64e(&secret)))].into_iter().collect();
        self.save(&v)?;
        let mut r = Value::Object(v);
        r["initialized"] = json!(true);
        Ok(r)
    }

    fn op_record(&self, q: &Value) -> Result<Value, String> {
        let mut v = self.load()?.ok_or_else(|| "recovery-required".to_string())?;
        if v.contains_key("record") {
            return Err("recovery-required".into());
        }
        let record = Self::req_str(q, "record")?;
        if record.encode_utf16().count() > MAX_RECORD {
            return Err("state-limit".into());
        }
        v.insert("record".to_string(), json!(record));
        self.save(&v)?;
        Ok(json!({}))
    }

    fn op_status(&self) -> Result<Value, String> {
        let v = self.load()?;
        if let Some(control) = v.as_ref() {
            if control.contains_key("wnfs") {
                let head = Self::wnfs_head(control)?;
                let mut clean = true;
                match self.inventory(WNFS_BYTES) {
                    Ok(entries) => {
                        let expected: Vec<Value> = head
                            .get("entries")
                            .and_then(Value::as_array)
                            .cloned()
                            .ok_or_else(|| "recovery-required".to_string())?;
                        if let Err(e) = self.no_unpublished(&self.files()?) {
                            if e != "unsynced-data" && e != "sync-size-limit" {
                                return Err(e);
                            }
                            clean = false;
                        } else if !Self::equal_inventory(&entries, &expected) {
                            clean = false;
                        }
                    }
                    Err(e) if e == "sync-size-limit" || e == "unsynced-data" => clean = false,
                    Err(e) => return Err(e),
                }
                return Ok(json!({
                    "initialized": true,
                    "synced": clean,
                    "origin": head.get("origin").cloned().unwrap_or(json!("")),
                    "wnfs": true,
                    "legacy": control.contains_key("pack"),
                    "evicted": false,
                }));
            }
        }
        let same: bool;
        let empty: bool;
        // Mirror Android: inventory, unpublished-scan and equality failures
        // that mean "not in sync" all collapse to same=false, empty=false.
        let probed: Result<Vec<Value>, String> = (|| {
            let entries = self.inventory(LEGACY_BYTES)?;
            self.no_unpublished(&self.files()?)?;
            Ok(entries)
        })();
        match probed {
            Ok(entries) => {
                empty = entries.is_empty();
                same = v.as_ref().is_some_and(|c| {
                    c.contains_key("entries")
                        && c.get("entries").and_then(Value::as_array).is_some_and(|e| Self::equal_inventory(&entries, e))
                });
            }
            Err(e) if e == "sync-size-limit" || e == "unsynced-data" => {
                same = false;
                empty = false;
            }
            Err(e) => return Err(e),
        }
        Ok(json!({
            "initialized": v.is_some(),
            "synced": same,
            "origin": v.as_ref().and_then(|c| c.get("origin")).cloned().unwrap_or(json!("")),
            "legacy": v.as_ref().is_some_and(|c| c.contains_key("pack")),
            "evicted": empty && v.as_ref().is_some_and(|c| c.contains_key("pack")) && !same,
        }))
    }

    fn op_read(&self, q: &Value) -> Result<Value, String> {
        let d = self.files()?;
        let f = d.resolve(Self::req_str(q, "path")?)?;
        let at = Self::req_i64(q, "offset")?;
        let length = Self::req_usize(q, "length")?;
        if !f.is_file() || at < 0 || length > CHUNK {
            return Err("invalid-path".into());
        }
        let size = f.metadata().map_err(|_| "invalid-path".to_string())?.len() as i64;
        if at.saturating_add(length as i64) > size {
            return Err("invalid-path".into());
        }
        let bytes = drive_files::read_range(&f, at as u64, length)?;
        Ok(json!({"bytes": b64e(&bytes)}))
    }

    fn op_commit(&self, q: &Value) -> Result<Value, String> {
        let mut v = self.load()?.ok_or_else(|| "recovery-required".to_string())?;
        if !v.contains_key("record") {
            return Err("recovery-required".into());
        }
        let entries = Self::req_entries(q)?;
        self.same(&entries)?;
        self.no_unpublished(&self.files()?)?;
        let root = digest_id(q.get("root").unwrap_or(&Value::Null))?;
        let pack = digest_id(q.get("pack").unwrap_or(&Value::Null))?;
        let origin = Self::req_str(q, "origin")?.to_string();
        v.insert("root".to_string(), json!(root));
        v.insert("pack".to_string(), json!(pack));
        v.insert("origin".to_string(), json!(origin));
        v.insert("entries".to_string(), Value::Array(entries));
        self.save(&v)?;
        Ok(json!({}))
    }

    fn op_evict(&self, q: &Value) -> Result<Value, String> {
        let v = self.load()?.ok_or_else(|| "unsynced-data".to_string())?;
        if v.contains_key("wnfs") || !v.contains_key("entries") || !v.contains_key("pack") {
            return Err("unsynced-data".into());
        }
        let origin = q.get("origin").and_then(Value::as_str).unwrap_or("");
        if v.get("origin").and_then(Value::as_str).unwrap_or("") != origin {
            return Err("unsynced-data".into());
        }
        let stored: Vec<Value> = v
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "unsynced-data".to_string())?;
        self.same(&stored)?;
        self.no_unpublished(&self.files()?)?;
        let detached = self.base.join(format!("drive-evict-{}", drive_files::unique_suffix()));
        fs::rename(&self.cache, &detached).map_err(|_| "storage-unavailable".to_string())?;
        if let Err(e) = (|| -> Result<(), String> {
            fs::create_dir(&self.cache).map_err(|_| "storage-unavailable".to_string())?;
            drive_files::fsync_dir(self.base.as_path())?;
            Ok(())
        })() {
            let _ = fs::rename(&detached, &self.cache);
            return Err(e);
        }
        self.remove_tree(&detached)?;
        Ok(json!({}))
    }

    fn op_restore_begin(&self) -> Result<Value, String> {
        let v = self.load()?.ok_or_else(|| "unsynced-data".to_string())?;
        if !v.contains_key("root") || !self.inventory(LEGACY_BYTES)?.is_empty() {
            return Err("unsynced-data".into());
        }
        self.no_unpublished(&self.files()?)?;
        let stage = self.stage_legacy();
        if stage.exists() {
            self.remove_tree(&stage)?;
        }
        fs::create_dir(&stage).map_err(|_| "storage-unavailable".to_string())?;
        Ok(json!({}))
    }

    fn op_restore_write(&self, q: &Value) -> Result<Value, String> {
        let stage = self.stage_legacy();
        if !stage.is_dir() {
            return Err("restore-required".into());
        }
        let d = DriveFiles::new(&stage)?;
        let target = d.resolve(Self::req_str(q, "path")?)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "storage-unavailable".to_string())?;
        }
        let bytes = b64d(Self::req_str(q, "bytes")?)?;
        if bytes.len() > CHUNK {
            return Err("state-limit".into());
        }
        if self.allocated(&stage, LEGACY_BYTES)?.saturating_add(bytes.len() as i64) > LEGACY_BYTES
            || drive_files::usable_space(&stage)? < RESERVE.saturating_add(bytes.len() as u64)
        {
            return Err("sync-size-limit".into());
        }
        let offset = Self::req_i64(q, "offset")?;
        if offset < 0 || offset > LEGACY_BYTES {
            return Err("invalid-path".into());
        }
        let mut out = File::options()
            .read(true)
            .write(true)
            .create(true)
            .open(&target)
            .map_err(|_| "invalid-path".to_string())?;
        // Append-only staging: the current length must equal the offset,
        // exactly like Android's `out.length() != offset` check.
        let len = out.metadata().map_err(|_| "invalid-path".to_string())?.len();
        if len != offset as u64 {
            return Err("invalid-path".into());
        }
        out.seek(SeekFrom::Start(offset as u64)).map_err(|_| "invalid-path".to_string())?;
        out.write_all(&bytes).map_err(|_| "invalid-path".to_string())?;
        out.sync_all().map_err(|_| "storage-unavailable".to_string())?;
        Ok(json!({}))
    }

    fn op_restore_publish(&self) -> Result<Value, String> {
        let v = self.load()?.ok_or_else(|| "unsynced-data".to_string())?;
        if !self.inventory(LEGACY_BYTES)?.is_empty() {
            return Err("unsynced-data".into());
        }
        self.no_unpublished(&self.files()?)?;
        let stage = self.stage_legacy();
        let d = DriveFiles::new(&stage)?;
        let rows = Self::req_entries(&Value::Object(v.clone()))?;
        for row in &rows {
            let f = d.resolve(Self::req_str(row, "path")?)?;
            if row.get("directory").and_then(Value::as_bool).unwrap_or(false) {
                fs::create_dir_all(&f).map_err(|_| "storage-unavailable".to_string())?;
            } else {
                let size = Self::req_i64(row, "size")?;
                let sha = Self::req_str(row, "sha256")?;
                if !f.is_file()
                    || f.metadata().map_err(|_| "restore-mismatch".to_string())?.len() as i64 != size
                    || drive_files::sha256_file(&f).map_err(|_| "restore-mismatch".to_string())? != sha
                {
                    return Err("restore-mismatch".into());
                }
            }
        }
        let check = DriveFiles::new(&stage)?;
        let mut actual: Vec<Value> = Vec::new();
        let mut total: i64 = 0;
        self.walk(&check, "", &mut actual, &mut total, LEGACY_BYTES)?;
        if !Self::equal_inventory(&actual, &rows) {
            return Err("restore-mismatch".into());
        }
        for dir in self.all_dirs(&stage)? {
            drive_files::fsync_dir(&dir)?;
        }
        let empty = self.base.join(format!("drive-empty-{}", drive_files::unique_suffix()));
        fs::rename(&self.cache, &empty).map_err(|_| "storage-unavailable".to_string())?;
        if let Err(e) = fs::rename(&stage, &self.cache) {
            let _ = fs::rename(&empty, &self.cache);
            let _ = e;
            return Err("storage-unavailable".into());
        }
        drive_files::fsync_dir(self.base.as_path())?;
        self.remove_tree(&empty)?;
        Ok(json!({}))
    }

    #[allow(clippy::too_many_lines)]
    fn op_wnfs_commit(&self, q: &Value) -> Result<Value, String> {
        let mut control = self.load()?.ok_or_else(|| "recovery-required".to_string())?;
        if !control.contains_key("record") {
            return Err("recovery-required".into());
        }
        let entries = Self::req_entries(q)?;
        if !Self::equal_inventory(&self.inventory(WNFS_BYTES)?, &entries) {
            return Err("unsynced-data".into());
        }
        self.no_unpublished(&self.files()?)?;
        let packs = q.get("packs").and_then(Value::as_array).ok_or_else(|| "invalid-root".to_string())?;
        if packs.is_empty() || packs.len() > 8 {
            return Err("invalid-root".into());
        }
        let mut ids = std::collections::HashSet::new();
        let capsule = digest_id(q.get("capsule").unwrap_or(&Value::Null))?;
        ids.insert(capsule.clone());
        let mut pack_ids = Vec::with_capacity(packs.len());
        for p in packs {
            let id = digest_id(p)?;
            if !ids.insert(id.clone()) {
                return Err("invalid-root".into());
            }
            pack_ids.push(json!(id));
        }
        let root = digest_id(q.get("root").unwrap_or(&Value::Null))?;
        let origin = Self::req_str(q, "origin")?.to_string();
        let head = json!({
            "schema": WNFS_SCHEMA,
            "root": root,
            "capsule": capsule,
            "packs": pack_ids,
            "origin": origin,
            "entries": entries,
        });
        control.insert("wnfs".to_string(), head);
        self.save(&control)?;
        Ok(json!({}))
    }

    fn op_wnfs_restore_begin(&self, q: &Value) -> Result<Value, String> {
        let control = self.load()?.ok_or_else(|| "recovery-required".to_string())?;
        if q.get("legacy").and_then(Value::as_bool).unwrap_or(false) {
            Self::legacy_head(&control)?;
        } else {
            Self::wnfs_head(&control)?;
        }
        let stage = self.stage_wnfs();
        if stage.exists() {
            self.remove_tree(&stage)?;
        }
        fs::create_dir(&stage).map_err(|_| "storage-unavailable".to_string())?;
        Ok(json!({}))
    }

    fn op_wnfs_restore_abort(&self) -> Result<Value, String> {
        let stage = self.stage_wnfs();
        if stage.exists() {
            self.remove_tree(&stage)?;
        }
        Ok(json!({}))
    }

    fn op_wnfs_restore_write(&self, q: &Value) -> Result<Value, String> {
        let stage = self.stage_wnfs();
        if !stage.is_dir() {
            return Err("restore-required".into());
        }
        let files = DriveFiles::new(&stage)?;
        let target = files.resolve(Self::req_str(q, "path")?)?;
        let offset = Self::req_i64(q, "offset")?;
        let bytes = b64d(Self::req_str(q, "bytes")?)?;
        if bytes.len() > CHUNK || offset < 0 || offset > WNFS_BYTES - bytes.len() as i64 {
            return Err("invalid-path".into());
        }
        if self.allocated(&stage, WNFS_BYTES)?.saturating_add(bytes.len() as i64) > WNFS_BYTES {
            return Err("sync-size-limit".into());
        }
        if drive_files::usable_space(&stage)? < RESERVE.saturating_add(bytes.len() as u64) {
            return Err("storage-full".into());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "storage-unavailable".to_string())?;
        }
        let mut out = File::options()
            .read(true)
            .write(true)
            .create(true)
            .open(&target)
            .map_err(|_| "restore-mismatch".to_string())?;
        let len = out.metadata().map_err(|_| "restore-mismatch".to_string())?.len();
        if len != offset as u64 {
            return Err("restore-mismatch".into());
        }
        out.seek(SeekFrom::Start(offset as u64)).map_err(|_| "restore-mismatch".to_string())?;
        out.write_all(&bytes).map_err(|_| "restore-mismatch".to_string())?;
        Ok(json!({}))
    }

    fn op_wnfs_restore_publish(&self, q: &Value) -> Result<Value, String> {
        let control = self.load()?.ok_or_else(|| "recovery-required".to_string())?;
        let stage = self.stage_wnfs();
        if !stage.is_dir() {
            return Err("restore-required".into());
        }
        let legacy = q.get("legacy").and_then(Value::as_bool).unwrap_or(false);
        let expected: Vec<Value> = if legacy {
            Self::legacy_head(&control)?;
            control
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| "recovery-required".to_string())?
        } else {
            let head = Self::wnfs_head(&control)?;
            head.get("entries")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| "recovery-required".to_string())?
        };
        let files = DriveFiles::new(&stage)?;
        for entry in &expected {
            let file = files.resolve(Self::req_str(entry, "path")?)?;
            if entry.get("directory").and_then(Value::as_bool).unwrap_or(false) {
                fs::create_dir_all(&file).map_err(|_| "storage-unavailable".to_string())?;
            } else if !file.is_file() {
                return Err("restore-mismatch".into());
            } else {
                File::open(&file)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| "restore-mismatch".to_string())?;
            }
        }
        let mut actual: Vec<Value> = Vec::new();
        let mut total: i64 = 0;
        self.walk(&files, "", &mut actual, &mut total, if legacy { LEGACY_BYTES } else { WNFS_BYTES })?;
        if !Self::equal_inventory(&actual, &expected) {
            return Err("restore-mismatch".into());
        }
        for dir in self.all_dirs(&stage)? {
            drive_files::fsync_dir(&dir)?;
        }
        let destination = self.files()?;
        if destination.list("")?.len() >= MAX_ENTRIES {
            return Err("entry-limit".into());
        }
        // No overwrite and no detaching the user's tree: only a validated
        // staged subtree becomes visible, under one rename on the app volume.
        let name = format!("Recovered {}", drive_files::unique_suffix());
        let target = destination.resolve(&name)?;
        if fs::symlink_metadata(&target).is_ok() {
            return Err("file-exists".into());
        }
        fs::rename(&stage, &target).map_err(|_| "storage-unavailable".to_string())?;
        drive_files::fsync_dir(&self.cache)?;
        Ok(json!({"folder": name}))
    }

    /// Execute one `drive_call` vault operation. `op` must already be allow-listed.
    pub fn execute_vault(&self, op: &str, q: &Value) -> Result<Value, String> {
        match op {
            "vaultSession" => self.op_session(q),
            "vaultRecord" => self.op_record(q),
            "vaultStatus" => self.op_status(),
            "vaultInventory" => Ok(json!({"entries": self.inventory(LEGACY_BYTES)?})),
            "vaultWnfsInventory" => Ok(json!({"entries": self.inventory(WNFS_BYTES)?})),
            "vaultRead" => self.op_read(q),
            "vaultCommit" => self.op_commit(q),
            "vaultEvict" => self.op_evict(q),
            "vaultRestoreBegin" => self.op_restore_begin(),
            "vaultRestoreWrite" => self.op_restore_write(q),
            "vaultRestorePublish" => self.op_restore_publish(),
            "vaultWnfsCommit" => self.op_wnfs_commit(q),
            "vaultWnfsRestoreBegin" => self.op_wnfs_restore_begin(q),
            "vaultWnfsRestoreAbort" => self.op_wnfs_restore_abort(),
            "vaultWnfsRestoreWrite" => self.op_wnfs_restore_write(q),
            "vaultWnfsRestorePublish" => self.op_wnfs_restore_publish(q),
            _ => Err("unsupported-operation".into()),
        }
    }
}

/// Serialized desktop drive surface: local files plus vault custody.
/// One instance guards all `drive_call` traffic like Android's single worker.
pub struct DesktopDrive<K: VaultKeyProvider> {
    lock: Mutex<()>,
    vault: Vault<K>,
}

impl<K: VaultKeyProvider> DesktopDrive<K> {
    pub fn new(keys: K, base: &Path) -> Result<Self, String> {
        Ok(Self {
            lock: Mutex::new(()),
            vault: Vault::new(keys, base)?,
        })
    }

    /// Execute any allow-listed `drive_call` operation (except `pick`/`open`
    /// handling differences documented below). Returns the JSON payload.
    pub fn execute(&self, op: &str, q: &Value) -> Result<Value, String> {
        let _guard = self.lock.lock().map_err(|_| "file-busy".to_string())?;
        match op {
            "list" => {
                let parent = Self::req_parent(q)?;
                let mut rows = Vec::new();
                for e in self.vault.files()?.list(&parent)? {
                    let mut row = Map::new();
                    row.insert("name".to_string(), json!(e.name));
                    row.insert("path".to_string(), json!(e.path));
                    row.insert("directory".to_string(), json!(e.directory));
                    if !e.directory {
                        row.insert("bytes".to_string(), json!(e.bytes));
                    }
                    row.insert("local".to_string(), json!(true));
                    row.insert("remoteVerified".to_string(), json!(false));
                    rows.push(Value::Object(row));
                }
                Ok(json!({"entries": rows}))
            }
            "mkdir" => {
                let parent = Self::req_parent(q)?;
                let name = Vault::<K>::req_str(q, "name")?;
                let files = self.vault.files()?;
                files.mkdir(&parent, name)?;
                drive_files::fsync_dir(&files.resolve(&parent)?)?;
                Ok(json!({}))
            }
            "createText" => {
                let parent = Self::req_parent(q)?;
                let name = Vault::<K>::req_str(q, "name")?;
                let text = Vault::<K>::req_str(q, "text")?;
                let bytes = text.as_bytes();
                if bytes.len() > 65536 {
                    return Err("drive-operation-failed".into());
                }
                let files = self.vault.files()?;
                let sha = files.copy_bytes(&parent, name, bytes, bytes.len() as i64)?;
                drive_files::fsync_dir(&files.resolve(&parent)?)?;
                Ok(json!({"sha256": sha}))
            }
            "pick" => Err("pick-unsupported".into()),
            "open" => self.op_open(q),
            _ if op.starts_with("vault") => self.vault.execute_vault(op, q),
            _ => Err("unsupported-operation".into()),
        }
    }

    fn req_parent(q: &Value) -> Result<String, String> {
        // `app.js` always sends `parent`; a missing one is a client bug.
        match q.get("parent").and_then(Value::as_str) {
            Some(p) => Ok(p.to_string()),
            None => Err("drive-operation-failed".into()),
        }
    }

    /// Open a cached file with its default macOS handler (LaunchServices
    /// equivalent of Android's `ACTION_VIEW` + FileProvider grant).
    #[cfg(target_os = "macos")]
    fn op_open(&self, q: &Value) -> Result<Value, String> {
        let f = self.vault.files()?.resolve(Vault::<K>::req_str(q, "path")?)?;
        if !f.is_file() {
            return Err("invalid-path".into());
        }
        std::process::Command::new("/usr/bin/open")
            .arg("--")
            .arg(&f)
            .spawn()
            .map_err(|_| "drive-operation-failed".to_string())?;
        Ok(json!({}))
    }

    #[cfg(not(target_os = "macos"))]
    fn op_open(&self, _q: &Value) -> Result<Value, String> {
        Err("pick-unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD as B64T};

    fn drive() -> (tempfile::TempDir, DesktopDrive<MemoryKeyProvider>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let d = DesktopDrive::new(MemoryKeyProvider::new(), dir.path()).expect("drive");
        (dir, d)
    }

    fn call(d: &DesktopDrive<MemoryKeyProvider>, op: &str, q: Value) -> Result<Value, String> {
        let mut req = Map::new();
        req.insert("op".to_string(), json!(op));
        if let Value::Object(extra) = q {
            req.extend(extra);
        }
        d.execute(op, &Value::Object(req))
    }

    fn status_synced(s: &Value) -> bool {
        s.get("synced").and_then(Value::as_bool).unwrap_or(false)
    }

    /// Mirror the JS `sync()` flow: session, record, inventory, commit.
    fn save_fixture(d: &DesktopDrive<MemoryKeyProvider>, origin: &str) -> Vec<Value> {
        assert_eq!(call(d, "vaultSession", json!({})).unwrap(), json!({"initialized": false}));
        let s = call(d, "vaultSession", json!({"initialize": true})).unwrap();
        assert_eq!(s.get("initialized"), Some(&json!(true)));
        assert!(s.get("secret").and_then(Value::as_str).is_some_and(|v| !v.is_empty()));
        call(d, "vaultRecord", json!({"record": "fixture-owner-record"})).unwrap();
        call(d, "mkdir", json!({"parent": "", "name": "notes"})).unwrap();
        let text = "restore-me-canary-3339";
        let created = call(d, "createText", json!({"parent": "notes", "name": "todo.txt", "text": text})).unwrap();
        assert!(created.get("sha256").and_then(Value::as_str).is_some());
        call(d, "createText", json!({"parent": "", "name": "empty-note.txt", "text": ""})).unwrap();
        let entries = call(d, "vaultInventory", json!({})).unwrap()["entries"].clone();
        let entries = entries.as_array().expect("entries").clone();
        assert!(entries.iter().any(|e| e["path"] == json!("notes/todo.txt") && !e["directory"].as_bool().unwrap()));
        assert!(entries.iter().any(|e| e["path"] == json!("notes") && e["directory"].as_bool().unwrap()));
        call(
            d,
            "vaultCommit",
            json!({"root": "ab".repeat(32), "pack": "cd".repeat(32), "origin": origin, "entries": entries}),
        )
        .unwrap();
        entries
    }

    #[test]
    fn save_evict_restore_decrypt_gives_identical_bytes() {
        let (_tmp, d) = drive();
        let origin = "https://example.invalid";
        let entries = save_fixture(&d, origin);

        let s = call(&d, "vaultStatus", json!({})).unwrap();
        assert!(status_synced(&s), "status must be synced after commit: {s}");
        assert_eq!(s["origin"], json!(origin));

        // Evict the local cache; committed state stays in the vault.
        call(&d, "vaultEvict", json!({"origin": origin})).unwrap();
        let s = call(&d, "vaultStatus", json!({})).unwrap();
        assert!(!status_synced(&s), "evicted cache must not read synced: {s}");
        assert_eq!(s["evicted"], json!(true));
        assert!(call(&d, "vaultInventory", json!({})).unwrap()["entries"].as_array().unwrap().is_empty());

        // Restore through the staging area, then publish.
        call(&d, "vaultRestoreBegin", json!({})).unwrap();
        let bodies: Vec<(String, Vec<u8>)> = entries
            .iter()
            .filter(|e| !e["directory"].as_bool().unwrap())
            .map(|e| {
                let path = e["path"].as_str().unwrap().to_string();
                let bytes = if path.ends_with("todo.txt") {
                    b"restore-me-canary-3339".to_vec()
                } else {
                    Vec::new()
                };
                (path, bytes)
            })
            .collect();
        for (path, bytes) in &bodies {
            // Exercise chunked appends, including the empty-file write.
            let mut at = 0usize;
            let chunks: Vec<&[u8]> = if bytes.is_empty() {
                vec![&[][..]]
            } else {
                vec![&bytes[..bytes.len() / 2], &bytes[bytes.len() / 2..]]
            };
            for chunk in chunks {
                call(
                    &d,
                    "vaultRestoreWrite",
                    json!({"path": path, "offset": at, "bytes": B64T.encode(chunk)}),
                )
                .unwrap();
                at += chunk.len();
            }
        }
        call(&d, "vaultRestorePublish", json!({})).unwrap();

        // Decrypt path: read every committed byte range back out.
        for (path, bytes) in &bodies {
            let size = bytes.len();
            let mut got = Vec::new();
            if size == 0 {
                // Android returns an empty base64 payload for empty files.
                let r = call(&d, "vaultRead", json!({"path": path, "offset": 0, "length": 0})).unwrap();
                assert_eq!(r["bytes"], json!(""));
                continue;
            }
            let mut at = 0usize;
            while at < size {
                let len = (size - at).min(7);
                let r = call(&d, "vaultRead", json!({"path": path, "offset": at, "length": len})).unwrap();
                got.extend_from_slice(&B64T.decode(r["bytes"].as_str().unwrap()).unwrap());
                at += len;
            }
            assert_eq!(&got, bytes, "restored bytes must be identical for {path}");
        }
        let s = call(&d, "vaultStatus", json!({})).unwrap();
        assert!(status_synced(&s), "restored cache must read synced again: {s}");
    }

    #[test]
    fn control_file_and_errors_carry_no_key_material() {
        let (tmp, d) = drive();
        let canary_record = "canary-owner-record-3339-secret";
        call(&d, "vaultSession", json!({"initialize": true})).unwrap();
        call(&d, "vaultRecord", json!({"record": canary_record})).unwrap();
        call(&d, "createText", json!({"parent": "", "name": "a.txt", "text": "x"})).unwrap();
        let entries = call(&d, "vaultInventory", json!({})).unwrap()["entries"].clone();
        call(
            &d,
            "vaultCommit",
            json!({"root": "ab".repeat(32), "pack": "cd".repeat(32), "origin": "https://example.invalid", "entries": entries}),
        )
        .unwrap();
        // The encrypted control file must not contain the record or any
        // base64 decodable copy of it in plaintext.
        let blob = std::fs::read(tmp.path().join("drive-vault-v1.bin")).expect("control file");
        let raw = String::from_utf8_lossy(&blob);
        assert!(!raw.contains(canary_record), "control file leaks record plaintext");
        assert!(!raw.contains("secret"), "control file leaks field names in plaintext");

        // Every failure surfaces a fixed code; canaries never echo.
        let bad = [
            call(&d, "vaultRecord", json!({"record": "x"})),
            call(&d, "vaultCommit", json!({"root": "ZZ", "pack": "cd".repeat(32), "origin": "o", "entries": []})),
            call(&d, "vaultRead", json!({"path": "a.txt", "offset": 99, "length": 7})),
            call(&d, "createText", json!({"parent": "", "name": ".pending-evil", "text": "x"})),
            call(&d, "createText", json!({"parent": "", "name": "../escape", "text": "x"})),
            call(&d, "mkdir", json!({"parent": "", "name": "a.txt"})),
            call(&d, "list", json!({"parent": "nope/missing"})),
            call(&d, "pick", json!({"parent": ""})),
        ];
        for r in bad {
            let code = r.expect_err("must refuse");
            assert!(!code.contains(canary_record), "error leaks key material: {code}");
            assert!(!code.contains("canary"), "error leaks key material: {code}");
        }
    }

    #[test]
    fn custody_state_machine_refuses_out_of_order_use() {
        let (_tmp, d) = drive();
        // No vault yet: reads and commits refuse, records refuse.
        assert_eq!(call(&d, "vaultRead", json!({"path": "a", "offset": 0, "length": 1})).unwrap_err(), "invalid-path");
        assert_eq!(call(&d, "vaultCommit", json!({"root": "ab".repeat(32), "pack": "cd".repeat(32), "origin": "o", "entries": []})).unwrap_err(), "recovery-required");
        assert_eq!(call(&d, "vaultRecord", json!({"record": "r"})).unwrap_err(), "recovery-required");
        assert_eq!(call(&d, "vaultEvict", json!({"origin": ""})).unwrap_err(), "unsynced-data");
        // Initializing twice keeps the first secret: the second record write
        // still refuses, so no silent re-key is possible.
        call(&d, "vaultSession", json!({"initialize": true})).unwrap();
        call(&d, "vaultRecord", json!({"record": "first"})).unwrap();
        assert_eq!(call(&d, "vaultRecord", json!({"record": "second"})).unwrap_err(), "recovery-required");
        // Existing key material blocks a fresh identity in this namespace.
        let session = call(&d, "vaultSession", json!({"initialize": true})).unwrap();
        assert_eq!(session["record"], json!("first"));
    }

    #[test]
    fn commit_rejects_uncommitted_and_tampered_inventory() {
        let (_tmp, d) = drive();
        let origin = "https://example.invalid";
        let entries = save_fixture(&d, origin);
        // A new local file after commit breaks equality: commit refuses.
        call(&d, "createText", json!({"parent": "", "name": "unsynced.txt", "text": "no"})).unwrap();
        assert_eq!(
            call(&d, "vaultCommit", json!({"root": "ab".repeat(32), "pack": "cd".repeat(32), "origin": origin, "entries": entries})).unwrap_err(),
            "unsynced-data"
        );
        // Evict with a changed endpoint also refuses instead of adopting it.
        assert_eq!(call(&d, "vaultEvict", json!({"origin": "https://other.invalid"})).unwrap_err(), "unsynced-data");
    }

    #[test]
    fn file_names_paths_and_ranges_use_android_codes() {
        let (_tmp, d) = drive();
        for name in [".", "..", ".pending-evil", "a/b", "bad\0name", "x".repeat(161).as_str()] {
            assert_eq!(
                call(&d, "createText", json!({"parent": "", "name": name, "text": "x"})).unwrap_err(),
                "invalid-name",
                "name {name:?}"
            );
        }
        // `..` and empty segments fail name validation on Android too, so
        // they surface as invalid-name; depth and length caps are invalid-path.
        for parent in ["../escape", "a//b"] {
            assert_eq!(call(&d, "list", json!({"parent": parent})).unwrap_err(), "invalid-name", "parent {parent:?}");
        }
        for parent in [&"a/".repeat(17), &"n".repeat(2049)] {
            assert_eq!(call(&d, "list", json!({"parent": parent})).unwrap_err(), "invalid-path", "parent too deep/long");
        }
        call(&d, "createText", json!({"parent": "", "name": "dup.txt", "text": "x"})).unwrap();
        assert_eq!(
            call(&d, "createText", json!({"parent": "", "name": "dup.txt", "text": "y"})).unwrap_err(),
            "file-exists"
        );
        assert_eq!(
            call(&d, "vaultRead", json!({"path": "dup.txt", "offset": 0, "length": 65532})).unwrap_err(),
            "invalid-path"
        );
        assert_eq!(
            call(&d, "vaultRead", json!({"path": "dup.txt", "offset": -1, "length": 1})).unwrap_err(),
            "invalid-path"
        );
        assert_eq!(call(&d, "vaultRestoreWrite", json!({"path": "x", "offset": 0, "bytes": ""})).unwrap_err(), "restore-required");
        // Restore staging rejects non-append offsets with invalid-path.
        call(&d, "vaultSession", json!({"initialize": true})).unwrap();
        call(&d, "vaultRecord", json!({"record": "r"})).unwrap();
        let entries = call(&d, "vaultInventory", json!({})).unwrap()["entries"].clone();
        call(&d, "vaultCommit", json!({"root": "ab".repeat(32), "pack": "cd".repeat(32), "origin": "o", "entries": entries})).unwrap();
        call(&d, "vaultEvict", json!({"origin": "o"})).unwrap();
        call(&d, "vaultRestoreBegin", json!({})).unwrap();
        assert_eq!(
            call(&d, "vaultRestoreWrite", json!({"path": "dup.txt", "offset": 4, "bytes": B64T.encode(b"nope")})).unwrap_err(),
            "invalid-path"
        );
    }

    #[test]
    fn list_and_create_shapes_match_android_contract() {
        let (_tmp, d) = drive();
        call(&d, "mkdir", json!({"parent": "", "name": "docs"})).unwrap();
        let sha = call(&d, "createText", json!({"parent": "docs", "name": "hello.txt", "text": "hi"})).unwrap();
        let mut digest = sha2::Sha256::new();
        use sha2::Digest as _;
        digest.update(b"hi");
        assert_eq!(sha["sha256"], json!(crate::drive_files::hex_bytes(&digest.finalize())));
        let list = call(&d, "list", json!({"parent": ""})).unwrap();
        let root_entries = list["entries"].as_array().unwrap();
        assert_eq!(root_entries.len(), 1);
        assert_eq!(root_entries[0]["name"], json!("docs"));
        assert_eq!(root_entries[0]["local"], json!(true));
        assert_eq!(root_entries[0]["remoteVerified"], json!(false));
        assert!(root_entries[0].get("bytes").is_none(), "directories carry no bytes key");
        let sub = call(&d, "list", json!({"parent": "docs"})).unwrap();
        let files = sub["entries"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["bytes"], json!(2));
    }

    #[test]
    fn wnfs_commit_and_staged_restore_publish_recovered_folder() {
        let (_tmp, d) = drive();
        let origin = "https://example.invalid";
        call(&d, "vaultSession", json!({"initialize": true})).unwrap();
        call(&d, "vaultRecord", json!({"record": "wnfs-record"})).unwrap();
        call(&d, "mkdir", json!({"parent": "", "name": "forest"})).unwrap();
        call(&d, "createText", json!({"parent": "forest", "name": "leaf.txt", "text": "canopy"})).unwrap();
        let entries = call(&d, "vaultWnfsInventory", json!({})).unwrap()["entries"].clone();
        let entries = entries.as_array().unwrap().clone();
        call(
            &d,
            "vaultWnfsCommit",
            json!({"root": "aa".repeat(32), "capsule": "bb".repeat(32), "packs": ["cc".repeat(32)], "origin": origin, "entries": entries}),
        )
        .unwrap();
        let s = call(&d, "vaultStatus", json!({})).unwrap();
        assert_eq!(s["wnfs"], json!(true));
        assert!(status_synced(&s), "wnfs status must be synced: {s}");

        // Abort clears a partial staging area; a fresh begin restages cleanly.
        call(&d, "vaultWnfsRestoreBegin", json!({})).unwrap();
        call(&d, "vaultWnfsRestoreWrite", json!({"path": "forest/leaf.txt", "offset": 0, "bytes": B64T.encode(b"can")})).unwrap();
        call(&d, "vaultWnfsRestoreAbort", json!({})).unwrap();
        call(&d, "vaultWnfsRestoreBegin", json!({})).unwrap();
        call(&d, "vaultWnfsRestoreWrite", json!({"path": "forest/leaf.txt", "offset": 0, "bytes": B64T.encode(b"canopy")})).unwrap();
        let published = call(&d, "vaultWnfsRestorePublish", json!({})).unwrap();
        let folder = published["folder"].as_str().expect("folder name").to_string();
        assert!(folder.starts_with("Recovered "), "unexpected folder {folder}");
        let root = call(&d, "list", json!({"parent": ""})).unwrap();
        assert!(root["entries"].as_array().unwrap().iter().any(|e| e["name"] == json!(folder)));
        // Legacy evict must refuse while a WNFS head is pinned.
        assert_eq!(call(&d, "vaultEvict", json!({"origin": origin})).unwrap_err(), "unsynced-data");
    }
}
