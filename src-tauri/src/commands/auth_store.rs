use serde::{Deserialize, Serialize};
use std::fmt;
use std::process::Command;
use zeroize::ZeroizeOnDrop;

pub const KEYCHAIN_SERVICE: &str = "CC-usage-credentials";
pub const KEYCHAIN_ACCOUNT: &str = "cc-usage";

/// Sentinel file path: ~/Library/Application Support/cc-usage/first-run.marker
pub fn sentinel_path() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("cc-usage").join("first-run.marker"))
}

pub fn sentinel_exists() -> bool {
    sentinel_path().map(|p| p.exists()).unwrap_or(false)
}

pub fn sentinel_create() -> std::io::Result<()> {
    if let Some(path) = sentinel_path() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !path.exists() {
            std::fs::write(&path, b"")?;
        }
    }
    Ok(())
}

#[derive(Debug)]
pub enum AuthStoreError {
    Missing,
    Malformed(String),
    KeychainCommandFailed(String),
}

impl fmt::Display for AuthStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthStoreError::Missing => write!(f, "keychain entry not found"),
            AuthStoreError::Malformed(e) => write!(f, "malformed keychain data: {}", e),
            AuthStoreError::KeychainCommandFailed(e) => write!(f, "keychain command failed: {}", e),
        }
    }
}

/// Deserialization struct for keychain JSON
#[derive(Serialize, Deserialize)]
struct StoredSecretsRaw {
    access_token: String,
    refresh_token: String,
    expires_at_ms: i64,
}

#[derive(ZeroizeOnDrop)]
pub struct CachedSecrets {
    pub access_token: String,
    pub refresh_token: String,
    #[zeroize(skip)]
    pub expires_at_ms: i64,
}

impl fmt::Debug for CachedSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CachedSecrets")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

pub enum LoadResult {
    Ok(CachedSecrets),
    None,
}

pub fn read_from_keychain() -> LoadResult {
    let output = match Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("read_from_keychain: command error: {}", e);
            return LoadResult::None;
        }
    };

    if !output.status.success() {
        return LoadResult::None;
    }

    let json_str = match String::from_utf8(output.stdout) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("read_from_keychain: utf8 decode error: {}", e);
            let _ = delete_from_keychain();
            return LoadResult::None;
        }
    };

    let raw: StoredSecretsRaw = match serde_json::from_str(json_str.trim()) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("read_from_keychain: malformed entry, cleaned up ({})", e);
            let _ = delete_from_keychain();
            return LoadResult::None;
        }
    };

    LoadResult::Ok(CachedSecrets {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        expires_at_ms: raw.expires_at_ms,
    })
}

pub fn write_to_keychain(secrets: &CachedSecrets) -> Result<(), AuthStoreError> {
    let raw = StoredSecretsRaw {
        access_token: secrets.access_token.clone(),
        refresh_token: secrets.refresh_token.clone(),
        expires_at_ms: secrets.expires_at_ms,
    };

    let json = serde_json::to_string(&raw)
        .map_err(|e| AuthStoreError::Malformed(e.to_string()))?;

    let output = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s", KEYCHAIN_SERVICE,
            "-a", KEYCHAIN_ACCOUNT,
            "-w", &json,
        ])
        .output()
        .map_err(|e| AuthStoreError::KeychainCommandFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AuthStoreError::KeychainCommandFailed(stderr));
    }

    Ok(())
}

pub fn delete_from_keychain() -> Result<(), AuthStoreError> {
    let output = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE])
        .output()
        .map_err(|e| AuthStoreError::KeychainCommandFailed(e.to_string()))?;

    // exit code 44 = item not found — treat as Ok
    if !output.status.success() {
        if let Some(code) = output.status.code() {
            if code == 44 {
                return Ok(());
            }
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AuthStoreError::KeychainCommandFailed(stderr));
    }

    Ok(())
}
