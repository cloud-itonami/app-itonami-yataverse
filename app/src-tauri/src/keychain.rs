//! macOS Keychain custody for the desktop vault.
//!
//! The 256-bit device data key lives as a generic-password Keychain item
//! under [`crate::vault::KEYCHAIN_SERVICE`]. It is created once on first
//! `vaultSession(initialize=true)`, read into memory for control-file
//! crypto, and never written anywhere else. Tests use the separate
//! [`crate::vault::KEYCHAIN_TEST_SERVICE`] and delete every item they
//! create; production code never enumerates the Keychain.

#[cfg(target_os = "macos")]
mod provider {
    use crate::vault::{ALIAS, KEYCHAIN_SERVICE, VaultKeyProvider};

    /// Keychain-backed [`VaultKeyProvider`].
    pub struct KeychainKeyProvider {
        service: String,
    }

    impl KeychainKeyProvider {
        pub fn production() -> Self {
            Self {
                service: KEYCHAIN_SERVICE.to_string(),
            }
        }

        #[allow(dead_code)]
        pub fn with_service(service: &str) -> Self {
            Self {
                service: service.to_string(),
            }
        }

        fn get(&self) -> Result<Option<[u8; 32]>, String> {
            use security_framework::passwords::get_generic_password;
            use zeroize::Zeroizing;
            match get_generic_password(&self.service, ALIAS) {
                Ok(secret) => {
                    // Wipe the Keychain copy on the way out: key material
                    // only travels in the fixed-size return array.
                    let secret = Zeroizing::new(secret);
                    if secret.len() != 32 {
                        // A foreign or corrupt item under our name refuses
                        // closed rather than decrypting with the wrong key.
                        return Err("drive-operation-failed".into());
                    }
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&secret);
                    Ok(Some(key))
                }
                Err(e) => {
                    if e.code() == -25300 { // errSecItemNotFound
                        Ok(None)
                    } else {
                        Err("drive-operation-failed".into())
                    }
                }
            }
        }
    }

    impl VaultKeyProvider for KeychainKeyProvider {
        fn key_exists(&self) -> Result<bool, String> {
            Ok(self.get()?.is_some())
        }

        fn load_key(&self) -> Result<Option<[u8; 32]>, String> {
            self.get()
        }

        fn store_key(&self, key: &[u8; 32]) -> Result<(), String> {
            use security_framework::passwords::set_generic_password;
            // Fixed codes only: OS errors never surface key material.
            set_generic_password(&self.service, ALIAS, key)
                .map_err(|_| "drive-operation-failed".to_string())
        }
    }

    /// Delete one test item. Test-only; production code never deletes keys.
    #[cfg(test)]
    pub fn delete_item(service: &str) -> Result<(), String> {
        use security_framework::passwords::delete_generic_password;
        match delete_generic_password(service, ALIAS) {
            Ok(()) => Ok(()),
            Err(e) => {
                if e.code() == -25300 { // errSecItemNotFound
                    Ok(())
                } else {
                    Err("drive-operation-failed".into())
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use provider::KeychainKeyProvider;

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(target_os = "macos")]
    fn real_keychain_roundtrip_uses_test_only_service() {
        use super::provider::{KeychainKeyProvider, delete_item};
        use crate::vault::{KEYCHAIN_TEST_SERVICE, VaultKeyProvider};

        /// Deletes the test item on drop so no Keychain entry survives,
        /// even when an assertion fails mid-test.
        struct Guard<'a> {
            service: &'a str,
        }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                let _ = delete_item(self.service);
            }
        }

        let unique = format!("{}-{}", KEYCHAIN_TEST_SERVICE, std::process::id());
        let _guard = Guard { service: &unique };
        let provider = KeychainKeyProvider::with_service(&unique);
        let _ = delete_item(&unique);

        assert!(
            !provider.key_exists().expect("keychain must be reachable"),
            "test service item must not pre-exist"
        );
        assert_eq!(provider.load_key().expect("load"), None);

        let mut key = [0u8; 32];
        getrandom::fill(&mut key).expect("rng");
        provider.store_key(&key).expect("store");
        assert!(provider.key_exists().expect("exists"));
        let loaded = provider.load_key().expect("load").expect("present");
        assert_eq!(loaded, key, "keychain must round-trip the exact bytes");
        key.fill(0);

        let _ = delete_item(&unique);
        assert_eq!(provider.load_key().expect("load after delete"), None);
        assert!(!provider.key_exists().expect("exists after delete"));
    }
}
