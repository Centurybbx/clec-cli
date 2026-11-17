use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::domain::{
    CORPUS_FORMAT, ClecError, DICTIONARY_REVISION, EQUIVALENCE_REVISION, ErrorCode,
    NORMALIZATION_REVISION, SCHEMA_VERSION, SEGMENTATION_REVISION, TOKENIZATION_REVISION,
};
use crate::snapshot::{ReleaseManifest, file_size_and_sha256, map_io};

pub(crate) const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const STAGING_ARTIFACT_TEMP_NAME: &str = ".incoming.zst.tmp";

pub(crate) fn cleanup_stale_staging(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(STAGING_ARTIFACT_TEMP_NAME));
}

pub(crate) fn is_staging_temp_name(name: &str) -> bool {
    name == STAGING_ARTIFACT_TEMP_NAME
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NetworkPolicy {
    Offline,
    Allowed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ManifestLocation {
    LocalPath(PathBuf),
    RemoteUrl(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArtifactLocation {
    LocalFile(PathBuf),
}

#[derive(Debug, Clone)]
pub(crate) struct LoadedManifest {
    pub manifest: ReleaseManifest,
    pub persistent_origin: String,
    pub artifact: ArtifactLocation,
}

#[derive(Debug)]
pub(crate) enum AcquiredArtifact {
    Local(PathBuf),
}

impl AcquiredArtifact {
    pub(crate) fn path(&self) -> &Path {
        match self {
            Self::Local(path) => path,
        }
    }
}

fn looks_like_windows_drive(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn has_url_scheme(raw: &str) -> bool {
    if looks_like_windows_drive(raw) {
        return false;
    }
    let Some((scheme, _)) = raw.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

impl ManifestLocation {
    pub(crate) fn parse(raw: &str) -> Result<Self, ClecError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.contains('\0') {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Manifest location must be a non-empty local path or HTTPS URL.",
            ));
        }
        if !has_url_scheme(trimmed) {
            return Ok(Self::LocalPath(PathBuf::from(trimmed)));
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            validate_remote_url_syntax(trimmed, ErrorCode::InvalidArgument)?;
            return Ok(Self::RemoteUrl(trimmed.to_owned()));
        }
        if let Some(rest) = lower.strip_prefix("file:") {
            let _ = rest;
            return parse_file_url(trimmed).map(Self::LocalPath);
        }
        Err(ClecError::new(
            ErrorCode::InvalidArgument,
            "Unsupported manifest URL scheme; pass a local path or HTTPS URL.",
        ))
    }
}

fn parse_file_url(raw: &str) -> Result<PathBuf, ClecError> {
    if raw.contains('#') {
        return Err(ClecError::new(
            ErrorCode::InvalidArgument,
            "URL fragments are unsupported in manifest locations.",
        ));
    }
    if let Some(after_slashes) = raw
        .strip_prefix("file://")
        .or_else(|| raw.strip_prefix("FILE://"))
    {
        if let Some(path_part) = after_slashes.strip_prefix('/') {
            return Ok(PathBuf::from(format!("/{path_part}")));
        }
        if let Some(rest) = after_slashes
            .strip_prefix("localhost/")
            .or_else(|| after_slashes.strip_prefix("LOCALHOST/"))
        {
            return Ok(PathBuf::from(format!("/{rest}")));
        }
        return Err(ClecError::new(
            ErrorCode::InvalidArgument,
            "Remote file:// hosts are unsupported; pass a local path.",
        ));
    }
    Err(ClecError::new(
        ErrorCode::InvalidArgument,
        "Invalid file:// URL; pass a local manifest path.",
    ))
}

pub(crate) fn validate_remote_url_syntax(raw: &str, err_code: ErrorCode) -> Result<(), ClecError> {
    if raw.trim().is_empty() || raw.contains('\0') || raw.contains('#') {
        return Err(ClecError::new(
            err_code,
            "Remote URL must not be empty or contain fragments.",
        ));
    }
    let lower = raw.to_ascii_lowercase();
    let after_scheme = if let Some(rest) = lower.strip_prefix("https://") {
        let orig_rest = &raw[8..];
        let authority = orig_rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.is_empty() || authority.contains('@') {
            return Err(ClecError::new(
                err_code,
                "Credentials and empty hosts in URLs are unsupported.",
            ));
        }
        let _ = rest;
        return Ok(());
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        return Err(ClecError::new(
            err_code,
            "Use HTTPS; plain HTTP is permitted only on loopback.",
        ));
    };
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(ClecError::new(
            err_code,
            "Credentials and empty hosts in URLs are unsupported.",
        ));
    }
    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if !matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return Err(ClecError::new(
            err_code,
            "Plain HTTP is permitted only for loopback fixtures; use HTTPS.",
        ));
    }
    Ok(())
}

pub(crate) fn validate_relative_path(raw: &str) -> Result<PathBuf, ClecError> {
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') {
        return Err(ClecError::new(
            ErrorCode::UnsafePath,
            format!("Invalid workspace-relative path '{raw}'."),
        ));
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(ClecError::new(
            ErrorCode::UnsafePath,
            format!("Source path '{raw}' must be relative to workspace."),
        ));
    }
    for comp in path.components() {
        match comp {
            Component::Normal(_) => {}
            _ => {
                return Err(ClecError::new(
                    ErrorCode::UnsafePath,
                    format!("Source path '{raw}' contains disallowed path components."),
                ));
            }
        }
    }
    Ok(path.to_path_buf())
}

pub(crate) fn validate_manifest_fields(m: &ReleaseManifest) -> Result<(), ClecError> {
    if m.schema_version != SCHEMA_VERSION {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            format!(
                "Unsupported manifest schemaVersion {}; expected {SCHEMA_VERSION}.",
                m.schema_version
            ),
        ));
    }
    if m.corpus_format != CORPUS_FORMAT {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            format!(
                "Unsupported corpusFormat '{}'; expected {CORPUS_FORMAT}.",
                m.corpus_format
            ),
        ));
    }
    if m.segmentation_revision != SEGMENTATION_REVISION {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Unsupported segmentationRevision in manifest.",
        ));
    }
    if m.tokenization_revision != TOKENIZATION_REVISION {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Unsupported tokenizationRevision in manifest.",
        ));
    }
    if m.normalization_revision != NORMALIZATION_REVISION {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Unsupported normalizationRevision in manifest.",
        ));
    }
    if m.dictionary_revision != DICTIONARY_REVISION {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Unsupported dictionaryRevision in manifest.",
        ));
    }
    if m.equivalence_revision != EQUIVALENCE_REVISION {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Unsupported equivalenceRevision in manifest.",
        ));
    }
    if m.bytes == 0
        || m.bytes > MAX_ARTIFACT_BYTES
        || m.compressed_bytes == 0
        || m.compressed_bytes > MAX_ARTIFACT_BYTES
    {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Manifest artifact byte sizes are out of bounds.",
        ));
    }
    if m.compressed_sha256.len() != 64
        || !m
            .compressed_sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Manifest compressedSha256 must be a 64-character lowercase hex digest.",
        ));
    }
    if let Some(artifact_url) = m.artifact_url.as_deref() {
        validate_remote_url_syntax(artifact_url, ErrorCode::InvalidPackage)?;
    }
    Ok(())
}

pub(crate) fn read_bounded_bytes<R: Read>(
    mut reader: R,
    max_bytes: usize,
) -> Result<Vec<u8>, ClecError> {
    let mut out = Vec::new();
    let mut buf = [0u8; 16_384];
    loop {
        let remaining = max_bytes.saturating_sub(out.len()) + 1;
        let to_read = remaining.min(buf.len());
        let n = reader.read(&mut buf[..to_read]).map_err(map_io)?;
        if n == 0 {
            break;
        }
        if out.len() + n > max_bytes {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                "Manifest exceeds 1 MiB limit.",
            ));
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok(out)
}

pub(crate) fn load_manifest(
    location: &ManifestLocation,
    network_policy: NetworkPolicy,
) -> Result<LoadedManifest, ClecError> {
    match location {
        ManifestLocation::LocalPath(raw_path) => {
            let manifest_path = std::fs::canonicalize(raw_path).map_err(|e| {
                ClecError::new(
                    ErrorCode::IoError,
                    format!("Cannot read manifest {}: {e}", raw_path.display()),
                )
            })?;
            let persistent_origin = manifest_path.display().to_string();
            let file = File::open(&manifest_path).map_err(map_io)?;
            let manifest_raw = read_bounded_bytes(file, MAX_MANIFEST_BYTES)?;
            let manifest: ReleaseManifest = serde_json::from_slice(&manifest_raw).map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Invalid manifest JSON: {e}"),
                )
            })?;
            validate_manifest_fields(&manifest)?;
            let rel_artifact = validate_relative_path(&manifest.artifact)?;
            let artifact_path = manifest_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(rel_artifact);
            Ok(LoadedManifest {
                manifest,
                persistent_origin,
                artifact: ArtifactLocation::LocalFile(artifact_path),
            })
        }
        ManifestLocation::RemoteUrl(_) => {
            let _ = network_policy;
            Err(ClecError::new(
                ErrorCode::UnsupportedFeature,
                "Remote HTTP sync is pending transport unit.",
            ))
        }
    }
}

pub(crate) fn acquire_artifact(
    loaded: &LoadedManifest,
    _data_dir: &Path,
    _network_policy: NetworkPolicy,
) -> Result<AcquiredArtifact, ClecError> {
    match &loaded.artifact {
        ArtifactLocation::LocalFile(artifact_path) => {
            if !artifact_path.is_file() {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Artifact {} is missing.", artifact_path.display()),
                ));
            }
            let (comp_bytes, comp_sha) = file_size_and_sha256(artifact_path)?;
            if comp_bytes != loaded.manifest.compressed_bytes
                || comp_sha != loaded.manifest.compressed_sha256
            {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "Compressed artifact size or SHA-256 does not match manifest.",
                ));
            }
            Ok(AcquiredArtifact::Local(artifact_path.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn manifest_location_distinguishes_local_paths_file_urls_and_remote_urls() {
        assert!(matches!(
            ManifestLocation::parse("manifest.json").unwrap(),
            ManifestLocation::LocalPath(_)
        ));
        assert!(matches!(
            ManifestLocation::parse("/tmp/release/manifest.json").unwrap(),
            ManifestLocation::LocalPath(_)
        ));
        assert!(matches!(
            ManifestLocation::parse("C:\\clec\\manifest.json").unwrap(),
            ManifestLocation::LocalPath(_)
        ));
        assert_eq!(
            ManifestLocation::parse("file:///tmp/manifest.json").unwrap(),
            ManifestLocation::LocalPath(PathBuf::from("/tmp/manifest.json"))
        );
        assert!(ManifestLocation::parse("file://otherhost/tmp/manifest.json").is_err());
        assert!(ManifestLocation::parse("ftp://example.com/manifest.json").is_err());
        assert!(ManifestLocation::parse("https://user:pass@example.com/manifest.json").is_err());
        assert!(ManifestLocation::parse("https://example.com/manifest.json#frag").is_err());
        assert!(ManifestLocation::parse("http://example.com/manifest.json").is_err());
        assert!(matches!(
            ManifestLocation::parse("http://127.0.0.1:8080/manifest.json").unwrap(),
            ManifestLocation::RemoteUrl(_)
        ));
        assert!(matches!(
            ManifestLocation::parse("https://example.com/manifest.json").unwrap(),
            ManifestLocation::RemoteUrl(_)
        ));
    }

    #[test]
    fn bounded_read_accepts_exact_limit_and_stops_at_sentinel_byte() {
        let exact = vec![b'a'; MAX_MANIFEST_BYTES];
        assert_eq!(
            read_bounded_bytes(Cursor::new(&exact), MAX_MANIFEST_BYTES)
                .unwrap()
                .len(),
            MAX_MANIFEST_BYTES
        );

        let oversized = vec![b'a'; MAX_MANIFEST_BYTES + 1];
        let err = read_bounded_bytes(Cursor::new(&oversized), MAX_MANIFEST_BYTES).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidManifest);
    }
}
