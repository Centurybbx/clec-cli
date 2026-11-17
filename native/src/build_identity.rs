#[macro_export]
macro_rules! clec_build_identity {
    ($kind:literal) => {
        concat!(
            "\0CLEC_BUILD_IDENTITY_V1\0",
            "{\"schemaVersion\":1",
            ",\"packageName\":\"",
            env!("CARGO_PKG_NAME"),
            "\"",
            ",\"packageVersion\":\"",
            env!("CARGO_PKG_VERSION"),
            "\"",
            ",\"artifactKind\":\"",
            $kind,
            "\"",
            ",\"target\":\"",
            env!("CLEC_BUILD_TARGET"),
            "\"",
            ",\"profile\":\"",
            env!("CLEC_BUILD_PROFILE"),
            "\"",
            ",\"features\":[",
            env!("CLEC_BUILD_FEATURES_JSON"),
            "]",
            ",\"testHooks\":",
            env!("CLEC_BUILD_TEST_HOOKS"),
            ",\"rustcVersion\":\"",
            env!("CLEC_BUILD_RUSTC_VERSION_ESCAPED"),
            "\"",
            ",\"cargoLockSha256\":\"",
            env!("CLEC_BUILD_CARGO_LOCK_SHA256"),
            "\"",
            "}\0END_CLEC_BUILD_IDENTITY_V1\0"
        )
        .as_bytes()
    };
}

#[inline(never)]
pub fn retain(identity: &'static [u8]) {
    std::hint::black_box(identity);
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EmbeddedIdentity {
        schema_version: u32,
        package_name: String,
        package_version: String,
        artifact_kind: String,
        target: String,
        profile: String,
        features: Vec<String>,
        test_hooks: bool,
        rustc_version: String,
        cargo_lock_sha256: String,
    }

    #[test]
    fn embedded_build_identity_is_valid_json_and_matches_compile_facts() {
        let raw = crate::clec_build_identity!("clec");
        let prefix = b"\0CLEC_BUILD_IDENTITY_V1\0";
        let suffix = b"\0END_CLEC_BUILD_IDENTITY_V1\0";
        assert!(raw.starts_with(prefix));
        assert!(raw.ends_with(suffix));
        let body = &raw[prefix.len()..raw.len() - suffix.len()];
        let parsed: EmbeddedIdentity = serde_json::from_slice(body).expect("valid identity JSON");

        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.package_name, "clec-native");
        assert_eq!(parsed.package_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(parsed.artifact_kind, "clec");
        assert!(!parsed.target.is_empty());
        assert!(!parsed.profile.is_empty());
        assert!(parsed.rustc_version.starts_with("rustc "));
        assert_eq!(parsed.test_hooks, cfg!(feature = "test-hooks"));
        if cfg!(feature = "test-hooks") {
            assert_eq!(parsed.features, vec!["test-hooks".to_owned()]);
        } else {
            assert!(parsed.features.is_empty());
        }
        assert_eq!(
            parsed.cargo_lock_sha256,
            crate::domain::sha256_hex(include_bytes!("../Cargo.lock"))
        );
    }
}
