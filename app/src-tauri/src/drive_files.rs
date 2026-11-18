//! Bounded app-private file adapter.
//!
//! Rust port of `DriveFiles.java` (Android) for the macOS desktop target.
//! Same bounds: entry names are NFC-normalized, relative paths are at most
//! 16 segments deep, listings hide `.pending-*` transients and cap at 1000
//! entries, and local imports cap at 1 GiB with a 64 MiB free-space reserve.
//! Error codes match the Android plugin exactly so the JS layer needs no
//! platform branches.

use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const MAX_BYTES: i64 = 1073741824;
pub const RESERVE: u64 = 64 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 1000;

/// File name as it appears in a `list` response.
pub struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub bytes: u64,
}

/// Validate and NFC-normalize one path segment. Mirrors `DriveFiles.name`
/// exactly: only the emptiness check trims, the 160-unit cap counts raw
/// UTF-16 units, and the stored name is NFC of the raw input (never trimmed,
/// so padded names stay distinct files like on Android).
pub fn valid_name(n: &str) -> Result<String, String> {
    // Java `String.trim()` strips chars <= U+0020; mirror that exactly.
    if n.trim_matches(|c: char| c <= '\u{20}').is_empty()
        || n.encode_utf16().count() > 160
        || n == "."
        || n == ".."
        || n.starts_with(".pending-")
        || n.chars().any(|c| c == '/' || c == '\\' || c < '\u{20}' || c == '\u{7f}')
    {
        return Err("invalid-name".into());
    }
    Ok(n.chars().nfc().collect())
}

/// Compare names the way `String.compareTo` does: by UTF-16 code unit.
/// UTF-8 byte order disagrees for supplementary characters (e.g. U+E000 vs
/// U+1F600), and inventory order feeds digests downstream.
fn cmp_name(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> std::cmp::Ordering {
    a.to_string_lossy()
        .encode_utf16()
        .cmp(b.to_string_lossy().encode_utf16())
}

pub struct DriveFiles {
    root: PathBuf,
}

impl DriveFiles {
    pub fn new(base: &Path) -> Result<Self, String> {
        fs::create_dir_all(base).map_err(|_| "storage-unavailable".to_string())?;
        let root = base
            .canonicalize()
            .map_err(|_| "storage-unavailable".to_string())?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a relative path, rejecting escapes and symlinks.
    /// Mirrors `DriveFiles.resolve`. The empty path addresses the root.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        if rel.encode_utf16().count() > 2048 {
            return Err("invalid-path".into());
        }
        if rel.is_empty() {
            return Ok(self.root.clone());
        }
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() > 16 {
            return Err("invalid-path".into());
        }
        let mut p = self.root.clone();
        for part in &parts {
            p.push(valid_name(part)?);
            match fs::symlink_metadata(&p) {
                Ok(md) => {
                    if md.file_type().is_symlink() {
                        return Err("invalid-path".into());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("invalid-path".into()),
            }
        }
        // Verify the nearest existing ancestor canonicalizes under the root,
        // so a swapped-in symlink between check and use cannot escape.
        let mut probe = p.clone();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if !probe.starts_with(&self.root) {
                return Err("invalid-path".into());
            }
            match probe.canonicalize() {
                Ok(canon) => {
                    if !canon.starts_with(&self.root) {
                        return Err("invalid-path".into());
                    }
                    let mut rebuilt = canon;
                    for comp in tail.iter().rev() {
                        rebuilt.push(comp);
                    }
                    if !rebuilt.starts_with(&self.root) {
                        return Err("invalid-path".into());
                    }
                    return Ok(p);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    match probe.file_name() {
                        Some(name) => {
                            tail.push(name.to_os_string());
                            probe.pop();
                        }
                        None => return Err("invalid-path".into()),
                    }
                }
                Err(_) => return Err("invalid-path".into()),
            }
        }
    }

    /// Relative slash path of a file under the root. Mirrors `DriveFiles.path`.
    pub fn path(&self, f: &Path) -> Result<String, String> {
        let canon = f.canonicalize().map_err(|_| "invalid-path".to_string())?;
        let rel = canon
            .strip_prefix(&self.root)
            .map_err(|_| "invalid-path".to_string())?;
        if rel.as_os_str().is_empty() {
            return Ok(String::new());
        }
        Ok(rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"))
    }

    fn directory(&self, rel: &str) -> Result<PathBuf, String> {
        let f = self.resolve(rel)?;
        if !f.is_dir() {
            return Err("invalid-path".into());
        }
        Ok(f)
    }

    /// List one directory, directories first then files, each by name.
    /// Mirrors `DriveFiles.list`, including `.pending-*` filtering.
    pub fn list(&self, rel: &str) -> Result<Vec<Entry>, String> {
        let dir = self.directory(rel)?;
        let read = fs::read_dir(&dir).map_err(|_| "storage-unavailable".to_string())?;
        let mut files: Vec<PathBuf> = Vec::new();
        for item in read {
            let item = item.map_err(|_| "storage-unavailable".to_string())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with(".pending-") {
                continue;
            }
            files.push(item.path());
        }
        if files.len() > MAX_ENTRIES {
            return Err("entry-limit".into());
        }
        for f in &files {
            if fs::symlink_metadata(f)
                .map(|md| md.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err("invalid-path".into());
            }
            // Re-validate every name the way the Android listing does.
            self.path(f).and_then(|rel| {
                for part in rel.split('/') {
                    valid_name(part)?;
                }
                Ok(rel)
            })?;
        }
        files.sort_by(|a, b| {
            let ad = a.is_dir();
            let bd = b.is_dir();
            match (ad, bd) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => {
                    let an = a.file_name().unwrap_or_else(|| std::ffi::OsStr::new(""));
                    let bn = b.file_name().unwrap_or_else(|| std::ffi::OsStr::new(""));
                    cmp_name(an, bn).then_with(|| a.cmp(b))
                }
            }
        });
        let mut out = Vec::with_capacity(files.len());
        for f in &files {
            let rel = self.path(f)?;
            let name = f
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .ok_or_else(|| "invalid-path".to_string())?;
            let directory = f.is_dir();
            let bytes = if directory {
                0
            } else {
                f.metadata().map_err(|_| "invalid-path".to_string())?.len()
            };
            out.push(Entry {
                name,
                path: rel,
                directory,
                bytes,
            });
        }
        Ok(out)
    }

    pub fn mkdir(&self, parent: &str, name: &str) -> Result<(), String> {
        // Validate the whole name first, like `DriveFiles.child` does:
        // a separator in `name` is invalid-name, never a nested path.
        valid_name(name)?;
        if self.list(parent)?.len() >= MAX_ENTRIES {
            return Err("entry-limit".into());
        }
        let rel = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        };
        let dest = self.resolve(&rel)?;
        match fs::create_dir(&dest) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err("file-exists".into()),
            Err(_) => Err("drive-operation-failed".into()),
        }
    }

    /// Atomically import `data` as `parent/name`, serialized with an
    /// OS-exclusive writer lock the way `DriveFiles.copy` does.
    /// `expected` mirrors the Android length contract: -1 unknown, else exact.
    pub fn copy_bytes(&self, parent: &str, name: &str, data: &[u8], expected: i64) -> Result<String, String> {
        valid_name(name)?;
        if expected > MAX_BYTES {
            return Err("file-too-large".into());
        }
        if expected < -1 {
            return Err("invalid-size".into());
        }
        let dir = self.directory(parent)?;
        if self.list(parent)?.len() >= MAX_ENTRIES {
            return Err("entry-limit".into());
        }
        let rel = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        };
        let dest = self.resolve(&rel)?;
        if fs::symlink_metadata(&dest).is_ok() {
            return Err("file-exists".into());
        }
        let total = data.len() as i64;
        if total > MAX_BYTES {
            return Err("file-too-large".into());
        }
        if expected >= 0 && total != expected {
            return Err("source-size-changed".into());
        }
        if usable_space(&dir)? < RESERVE.saturating_add(total.max(0) as u64) {
            return Err("storage-full".into());
        }
        if usable_space(&dir)? < RESERVE.saturating_add(data.len() as u64) {
            return Err("storage-full".into());
        }
        // Stage through a `.pending-*` temp file, exactly like Android.
        let mut tmp_path = dir.clone();
        tmp_path.push(format!(".pending-import-{}.part", unique_suffix()));
        let mut digest = Sha256::new();
        digest.update(data);
        let hash = hex_bytes(&digest.finalize());
        {
            let mut tmp = File::create(&tmp_path).map_err(|_| "storage-unavailable".to_string())?;
            tmp.write_all(data)
                .map_err(|_| "storage-unavailable".to_string())?;
            tmp.sync_all()
                .map_err(|_| "storage-unavailable".to_string())?;
        }
        let published = self.publish_staged(&dir, &tmp_path, &dest);
        let _ = fs::remove_file(&tmp_path);
        published?;
        fsync_dir(&dir)?;
        Ok(hash)
    }

    /// Hold the writer lock, recheck no-clobber, then atomically publish.
    /// The temp file is removed by the caller.
    fn publish_staged(&self, dir: &Path, tmp: &Path, dest: &Path) -> Result<(), String> {
        let guard_path = dir.join(".pending-writer.lock");
        let guard = File::options()
            .read(true)
            .write(true)
            .create(true)
            .open(&guard_path)
            .map_err(|_| "storage-unavailable".to_string())?;
        lock_exclusive_nb(&guard)?;
        if fs::symlink_metadata(dest).is_ok() {
            return Err("file-exists".into());
        }
        fs::rename(tmp, dest).map_err(|_| "storage-unavailable".to_string())?;
        Ok(())
    }
}

/// Read a bounded byte range from a file. Used by `vaultRead` and restore verify.
pub fn read_range(f: &Path, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let mut file = File::open(f).map_err(|_| "invalid-path".to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "invalid-path".to_string())?;
    let mut buf = vec![0u8; length];
    file.read_exact(&mut buf)
        .map_err(|_| "invalid-path".to_string())?;
    Ok(buf)
}

/// SHA-256 hex digest of a file. Mirrors `DriveVault.hash`.
pub fn sha256_file(f: &Path) -> Result<String, String> {
    let mut file = File::open(f).map_err(|_| "invalid-path".to_string())?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|_| "invalid-path".to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(hex_bytes(&digest.finalize()))
}

pub fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char);
    }
    out
}

pub fn fsync_dir(dir: &Path) -> Result<(), String> {
    File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(|_| "storage-unavailable".to_string())
}

pub fn usable_space(dir: &Path) -> Result<u64, String> {
    #[cfg(unix)]
    {
        let c = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes())
            .map_err(|_| "storage-unavailable".to_string())?;
        let mut st: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: statfs writes a valid struct on success; path is NUL-free.
        if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
            return Err("storage-unavailable".into());
        }
        Ok((st.f_bavail as u64).saturating_mul(st.f_bsize as u64))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Err("storage-unavailable".into())
    }
}

fn lock_exclusive_nb(f: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: flock on an owned open fd; non-blocking exclusive take.
        let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return Err("file-busy".into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = f;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `DriveFiles.name` validates the raw name: only the emptiness check
    /// trims, the length cap counts raw UTF-16 units, and the stored name is
    /// NFC of the raw input (never trimmed).
    #[test]
    fn name_mirrors_java_raw_validation_and_nfc() {
        assert_eq!(valid_name(" a").unwrap(), " a");
        assert_eq!(valid_name("a ").unwrap(), "a ");
        assert_eq!(valid_name("é").unwrap(), "é");
        // 161 raw UTF-16 units with trimmable padding: Java rejects on the
        // raw length even though the trimmed rest is short.
        let padded = format!("{}b", " ".repeat(160));
        assert_eq!(valid_name(&padded).unwrap_err(), "invalid-name");
        for bad in [".", "..", ".pending-x", "a/b", "a\\b", "bad\nname", " dot-padded "] {
            if bad == " dot-padded " {
                // Leading/trailing spaces are legal on Android; only the
                // all-blank name is rejected.
                assert!(valid_name(bad).is_ok(), "name {bad:?}");
                continue;
            }
            assert_eq!(valid_name(bad).unwrap_err(), "invalid-name", "name {bad:?}");
        }
        assert_eq!(valid_name("   ").unwrap_err(), "invalid-name");
    }

    /// `DriveFiles.list` sorts by `String.compareTo`: UTF-16 code units.
    /// The emoji lead surrogate (0xD83D) sorts before U+E000, while UTF-8
    /// byte order would put U+E000 first.
    #[test]
    fn list_order_matches_java_utf16_comparison() {
        let dir = tempfile::tempdir().expect("tempdir");
        let files = DriveFiles::new(dir.path()).expect("files");
        files.copy_bytes("", "\u{e000}.txt", b"x", 1).expect("e000");
        files.copy_bytes("", "\u{1f600}.txt", b"x", 1).expect("emoji");
        let names: Vec<String> = files.list("").expect("list").into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["\u{1f600}.txt".to_string(), "\u{e000}.txt".to_string()]);
    }
}

pub fn unique_suffix() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap_or_else(|_| {
        // Last-resort fallback only affects temp-file uniqueness, never keys.
        let t = std::time::SystemTime::now();
        let n = t
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u128)
            .unwrap_or(0);
        bytes[..16].copy_from_slice(&n.to_le_bytes());
    });
    // UUID v4 shape, matching Android's `UUID.randomUUID()` staging names.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}
