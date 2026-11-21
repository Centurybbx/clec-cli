use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::Url;
use reqwest::header::LOCATION;
use sha2::{Digest, Sha256};

use crate::domain::{
    CORPUS_FORMAT, ClecError, DICTIONARY_REVISION, EQUIVALENCE_REVISION, ErrorCode, SCHEMA_VERSION,
    SEGMENTATION_REVISION, TOKENIZATION_REVISION, hex_encode,
};
#[cfg(any(test, feature = "test-hooks"))]
use crate::http_transport::current_test_hooks;
use crate::http_transport::{
    AddressFailureReason, DnsFailureReason, EncodingFailureReason, HttpRequest,
    RedirectFailureReason, RemoteTransfer, SendReadFailureReason, SetupFailureReason,
    TransferEvent, TransferLimits, TransportFailure, WorkerContext, is_localhost_domain,
    is_loopback_literal_host,
};
use crate::snapshot::{ReleaseManifest, file_size_and_sha256, map_io};

pub(crate) const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const MAX_REDIRECTS: usize = 5;
pub(crate) const STAGING_ARTIFACT_TEMP_NAME: &str = ".incoming.zst.tmp";

#[derive(Debug, Clone)]
pub(crate) struct TransferPolicy {
    pub connect_timeout: Duration,
    pub manifest_timeout: Duration,
    pub artifact_timeout: Duration,
    #[cfg(any(test, feature = "test-hooks"))]
    pub extra_root_pem: Option<Vec<u8>>,
}

impl TransferPolicy {
    pub(crate) fn shipped() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            manifest_timeout: Duration::from_secs(30),
            artifact_timeout: Duration::from_secs(300),
            #[cfg(any(test, feature = "test-hooks"))]
            extra_root_pem: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NetworkPolicy {
    Offline,
    Allowed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ManifestLocation {
    LocalPath(PathBuf),
    RemoteUrl(Url),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArtifactLocation {
    LocalFile(PathBuf),
    RemoteUrl(Url),
}

#[derive(Debug, Clone)]
pub(crate) struct LoadedManifest {
    pub manifest: ReleaseManifest,
    pub persistent_origin: String,
    pub artifact: ArtifactLocation,
}

#[derive(Debug)]
struct RemoteTempGuard {
    path: PathBuf,
}

impl Drop for RemoteTempGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Debug)]
enum AcquiredKind {
    Local(PathBuf),
    RemoteTemp {
        path: PathBuf,
        _guard: RemoteTempGuard,
    },
}

#[derive(Debug)]
pub(crate) struct AcquiredArtifact(AcquiredKind);

impl AcquiredArtifact {
    pub(crate) fn path(&self) -> &Path {
        match &self.0 {
            AcquiredKind::Local(path) | AcquiredKind::RemoteTemp { path, .. } => path,
        }
    }
}

pub(crate) fn cleanup_stale_staging(data_dir: &Path) {
    let _ = fs::remove_file(data_dir.join(STAGING_ARTIFACT_TEMP_NAME));
}

pub(crate) fn is_staging_temp_name(name: &str) -> bool {
    name == STAGING_ARTIFACT_TEMP_NAME
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

pub(crate) fn redact_url_for_error(url: &Url) -> String {
    let scheme = url.scheme();
    match url.host_str() {
        Some(host) => match url.port() {
            Some(port) => format!("{scheme}://{host}:{port}{}", url.path()),
            None => format!("{scheme}://{host}{}", url.path()),
        },
        None => format!("{scheme}://{}", url.path()),
    }
}

pub(crate) fn validate_remote_url(raw: &str, err_code: ErrorCode) -> Result<Url, ClecError> {
    if raw.trim().is_empty() || raw.contains('\0') || raw.contains('#') {
        return Err(ClecError::new(
            err_code,
            "Remote URL must not be empty or contain fragments.",
        ));
    }
    let url = Url::parse(raw)
        .map_err(|_| ClecError::new(err_code, "Expected a valid absolute HTTP(S) URL."))?;
    check_remote_url_policy(&url, err_code)?;
    Ok(url)
}

fn check_remote_url_policy(url: &Url, err_code: ErrorCode) -> Result<(), ClecError> {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(ClecError::new(
            err_code,
            "Credentials and URL fragments are unsupported.",
        ));
    }
    match url.scheme() {
        "https" => {
            if url.host_str().is_none_or(str::is_empty) {
                return Err(ClecError::new(err_code, "HTTPS URL must include a host."));
            }
            Ok(())
        }
        "http" => {
            let Some(host) = url.host_str() else {
                return Err(ClecError::new(err_code, "HTTP URL must include a host."));
            };
            if is_localhost_domain(url) || is_loopback_literal_host(host) {
                Ok(())
            } else {
                Err(ClecError::new(
                    err_code,
                    "Plain HTTP is permitted only for loopback fixtures; use HTTPS.",
                ))
            }
        }
        _ => Err(ClecError::new(
            err_code,
            "Unsupported URL scheme; use HTTPS.",
        )),
    }
}

pub(crate) fn validate_remote_url_syntax(raw: &str, err_code: ErrorCode) -> Result<(), ClecError> {
    validate_remote_url(raw, err_code).map(|_| ())
}

fn parse_file_url(raw: &str) -> Result<PathBuf, ClecError> {
    if raw.contains('#') {
        return Err(ClecError::new(
            ErrorCode::InvalidArgument,
            "URL fragments are unsupported in manifest locations.",
        ));
    }
    let url = Url::parse(raw)
        .map_err(|_| ClecError::new(ErrorCode::InvalidArgument, "Invalid file:// URL."))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(ClecError::new(
            ErrorCode::InvalidArgument,
            "Credentials, queries, and fragments are unsupported in file:// URLs.",
        ));
    }
    let normalized = match url.host_str() {
        None | Some("") => url,
        Some(h) if h.eq_ignore_ascii_case("localhost") => {
            let mut local = url.clone();
            local.set_host(None).map_err(|_| {
                ClecError::new(
                    ErrorCode::InvalidArgument,
                    "Invalid file://localhost URL; pass a local manifest path.",
                )
            })?;
            local
        }
        Some(_) => {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Remote file:// hosts are unsupported; pass a local manifest path.",
            ));
        }
    };
    normalized.to_file_path().map_err(|_| {
        ClecError::new(
            ErrorCode::InvalidArgument,
            "Invalid file:// URL; pass a local manifest path.",
        )
    })
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
        if trimmed.contains('#') {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "URL fragments are unsupported in manifest locations.",
            ));
        }
        let parsed = Url::parse(trimmed).map_err(|_| {
            ClecError::new(ErrorCode::InvalidArgument, "Invalid manifest URL location.")
        })?;
        match parsed.scheme() {
            "http" | "https" => {
                check_remote_url_policy(&parsed, ErrorCode::InvalidArgument)?;
                Ok(Self::RemoteUrl(parsed))
            }
            "file" => parse_file_url(trimmed).map(Self::LocalPath),
            _ => Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Unsupported manifest URL scheme; pass a local path or HTTPS URL.",
            )),
        }
    }
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
    if crate::lexical::Normalization::parse(&m.normalization_revision).is_err() {
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
        validate_remote_url(artifact_url, ErrorCode::InvalidPackage)?;
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

#[cfg(test)]
fn ensure_localhost_loopback_with<F>(
    url: &Url,
    resolver: F,
) -> Result<Option<Vec<std::net::SocketAddr>>, ClecError>
where
    F: FnOnce(&str, u16) -> std::io::Result<Vec<std::net::SocketAddr>>,
{
    if url.scheme() != "http" || !is_localhost_domain(url) {
        return Ok(None);
    }
    let dom = url.host_str().unwrap_or("localhost");
    let port = url.port_or_known_default().unwrap_or(80);
    let safe_url = redact_url_for_error(url);
    let addrs = resolver(dom, port).map_err(|e| {
        ClecError::new(
            ErrorCode::TransferFailed,
            format!("Failed to resolve localhost for {safe_url}: {e}"),
        )
    })?;
    if addrs.is_empty() || !addrs.iter().all(|addr| addr.ip().is_loopback()) {
        return Err(ClecError::new(
            ErrorCode::TransferFailed,
            format!(
                "Refusing plain HTTP for {safe_url}: localhost resolved to non-loopback address."
            ),
        ));
    }
    Ok(Some(addrs))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferPhase {
    Manifest,
    Artifact,
}

impl TransferPhase {
    fn label(self) -> &'static str {
        match self {
            Self::Manifest => "manifest",
            Self::Artifact => "artifact",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Manifest => "Manifest",
            Self::Artifact => "Artifact",
        }
    }
}

fn map_transport_failure(err: TransportFailure, phase: TransferPhase, safe_url: &str) -> ClecError {
    let label = phase.label();
    let title = phase.title();
    match err {
        TransportFailure::Timeout => ClecError::new(
            ErrorCode::TransferTimeout,
            format!("{title} transfer timed out for {safe_url}."),
        ),
        TransportFailure::Cancelled => ClecError::new(
            ErrorCode::TransferFailed,
            format!("{label} transfer cancelled for {safe_url}."),
        ),
        TransportFailure::SpawnFailed => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Failed to start {label} transfer worker for {safe_url}."),
        ),
        TransportFailure::Disconnected => ClecError::new(
            ErrorCode::TransferFailed,
            format!("{label} transfer worker disconnected unexpectedly for {safe_url}."),
        ),
        TransportFailure::Dns(DnsFailureReason::MissingHost) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("URL missing host for {safe_url}."),
        ),
        TransportFailure::Dns(DnsFailureReason::ResolveError) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Failed to resolve host for {safe_url}."),
        ),
        TransportFailure::Dns(DnsFailureReason::EmptyAddresses) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("DNS resolution returned no addresses for {safe_url}."),
        ),
        TransportFailure::AddressPolicy(AddressFailureReason::DisallowedUrl) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Disallowed URL policy for {safe_url}."),
        ),
        TransportFailure::AddressPolicy(AddressFailureReason::NonLoopbackHttp) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Refusing plain HTTP to non-loopback address for {safe_url}."),
        ),
        TransportFailure::AddressPolicy(AddressFailureReason::UnpinnedRemote) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Connected address did not match resolved host addresses for {safe_url}."),
        ),
        #[cfg(any(test, feature = "test-hooks"))]
        TransportFailure::Setup(SetupFailureReason::InvalidFixtureCert) => ClecError::new(
            ErrorCode::InternalError,
            "Invalid fixture root certificate PEM.",
        ),
        TransportFailure::Setup(SetupFailureReason::ClientBuildFailed) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("HTTP client initialization failed for {safe_url}."),
        ),
        TransportFailure::SendOrRead(
            SendReadFailureReason::SendFailed | SendReadFailureReason::ReadFailed,
        ) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("{label} transfer failed for {safe_url}."),
        ),
        TransportFailure::Encoding(EncodingFailureReason::InvalidHeader) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Invalid Content-Encoding header during {label} fetch from {safe_url}."),
        ),
        TransportFailure::Encoding(EncodingFailureReason::NonIdentity) => ClecError::new(
            ErrorCode::TransferFailed,
            format!(
                "Unsupported Content-Encoding during {label} fetch from {safe_url}; expected identity."
            ),
        ),
        TransportFailure::RedirectPolicy(RedirectFailureReason::TooMany) => ClecError::new(
            ErrorCode::TransferFailed,
            format!(
                "Exceeded maximum of {MAX_REDIRECTS} HTTP redirects during {label} fetch from {safe_url}."
            ),
        ),
        TransportFailure::RedirectPolicy(RedirectFailureReason::MissingLocation) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("HTTP redirect missing Location header from {safe_url}."),
        ),
        TransportFailure::RedirectPolicy(RedirectFailureReason::InvalidLocation) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Invalid redirect Location header from {safe_url}."),
        ),
        TransportFailure::RedirectPolicy(RedirectFailureReason::Fragment) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Redirect target from {safe_url} must not contain a URL fragment."),
        ),
        TransportFailure::RedirectPolicy(RedirectFailureReason::MalformedLocation) => {
            ClecError::new(
                ErrorCode::TransferFailed,
                format!("Malformed redirect Location header from {safe_url}."),
            )
        }
        TransportFailure::RedirectPolicy(RedirectFailureReason::DisallowedTarget) => {
            ClecError::new(
                ErrorCode::TransferFailed,
                format!("Redirect target violated URL policy from {safe_url}."),
            )
        }
        TransportFailure::RedirectPolicy(RedirectFailureReason::HttpsDowngrade) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("Refusing HTTPS-to-HTTP redirect downgrade from {safe_url}."),
        ),
        TransportFailure::HttpStatus(status) => ClecError::new(
            ErrorCode::TransferFailed,
            format!("HTTP {status} during {label} fetch from {safe_url}."),
        ),
        TransportFailure::InvalidRequest => ClecError::new(
            ErrorCode::InternalError,
            "Invalid HTTP request variant for GET transfer session.",
        ),
    }
}

fn run_get_session(request: HttpRequest, ctx: &WorkerContext) -> Result<(), TransportFailure> {
    let HttpRequest::Get { url } = request else {
        return Err(TransportFailure::InvalidRequest);
    };
    let mut current_url = url;

    for hop in 0..=MAX_REDIRECTS {
        ctx.check_active()?;
        if check_remote_url_policy(&current_url, ErrorCode::TransferFailed).is_err() {
            return Err(TransportFailure::RedirectPolicy(
                RedirectFailureReason::DisallowedTarget,
            ));
        }

        let resp = ctx.send(HttpRequest::Get {
            url: current_url.clone(),
        })?;
        let status = resp.status();

        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if hop == MAX_REDIRECTS {
                return Err(TransportFailure::RedirectPolicy(
                    RedirectFailureReason::TooMany,
                ));
            }
            let location_header =
                resp.headers()
                    .get(LOCATION)
                    .ok_or(TransportFailure::RedirectPolicy(
                        RedirectFailureReason::MissingLocation,
                    ))?;
            let location_str = location_header.to_str().map_err(|_| {
                TransportFailure::RedirectPolicy(RedirectFailureReason::InvalidLocation)
            })?;
            if location_str.contains('#') {
                return Err(TransportFailure::RedirectPolicy(
                    RedirectFailureReason::Fragment,
                ));
            }
            let next_url = resp.url().join(location_str).map_err(|_| {
                TransportFailure::RedirectPolicy(RedirectFailureReason::MalformedLocation)
            })?;
            if check_remote_url_policy(&next_url, ErrorCode::TransferFailed).is_err() {
                return Err(TransportFailure::RedirectPolicy(
                    RedirectFailureReason::DisallowedTarget,
                ));
            }
            if current_url.scheme() == "https" && next_url.scheme() != "https" {
                return Err(TransportFailure::RedirectPolicy(
                    RedirectFailureReason::HttpsDowngrade,
                ));
            }
            drop(resp);
            ctx.check_active()?;
            current_url = next_url;
            continue;
        }

        if status != 200 {
            return Err(TransportFailure::HttpStatus(status));
        }

        return ctx.stream(resp);
    }

    Err(TransportFailure::RedirectPolicy(
        RedirectFailureReason::TooMany,
    ))
}

fn start_get_transfer(
    url: &Url,
    phase: TransferPhase,
    deadline: Instant,
    max_body_bytes: u64,
    transfer_policy: &TransferPolicy,
    #[cfg(any(test, feature = "test-hooks"))] hooks: crate::http_transport::TestTransferHooks,
) -> Result<(RemoteTransfer, String), ClecError> {
    let safe_url = redact_url_for_error(url);
    let limits = TransferLimits {
        deadline,
        connect_timeout: transfer_policy.connect_timeout,
        max_body_bytes,
        #[cfg(any(test, feature = "test-hooks"))]
        extra_root_pem: transfer_policy.extra_root_pem.clone(),
        #[cfg(any(test, feature = "test-hooks"))]
        hooks,
    };
    let transfer = RemoteTransfer::start(
        HttpRequest::Get { url: url.clone() },
        limits,
        run_get_session,
    )
    .map_err(|err| map_transport_failure(err, phase, &safe_url))?;
    Ok((transfer, safe_url))
}

fn recv_get_head(
    transfer: &mut RemoteTransfer,
    phase: TransferPhase,
    safe_url: &mut String,
) -> Result<(Url, Option<u64>), ClecError> {
    match transfer
        .recv_event()
        .map_err(|err| map_transport_failure(err, phase, safe_url))?
    {
        TransferEvent::Head {
            final_url,
            status,
            content_length,
        } => {
            *safe_url = redact_url_for_error(&final_url);
            if status != 200 {
                return Err(map_transport_failure(
                    TransportFailure::HttpStatus(status),
                    phase,
                    safe_url,
                ));
            }
            Ok((final_url, content_length))
        }
        TransferEvent::Finished(Err(err)) => Err(map_transport_failure(err, phase, safe_url)),
        TransferEvent::Finished(Ok(())) | TransferEvent::Chunk(_) => Err(ClecError::new(
            ErrorCode::TransferFailed,
            format!(
                "{} transfer ended before response headers for {}.",
                phase.label(),
                safe_url
            ),
        )),
    }
}

fn resolve_remote_artifact_url(
    manifest: &ReleaseManifest,
    final_manifest_url: &Url,
) -> Result<Url, ClecError> {
    let resolved = match manifest.artifact_url.as_deref() {
        Some(raw) => validate_remote_url(raw, ErrorCode::InvalidPackage)?,
        None => {
            validate_relative_path(&manifest.artifact)?;
            if manifest.artifact.contains('?')
                || manifest.artifact.contains('#')
                || manifest.artifact.contains(':')
            {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Manifest artifact path contains disallowed URL characters.",
                ));
            }
            final_manifest_url.join(&manifest.artifact).map_err(|_| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Failed to resolve relative artifact URL against manifest URL.",
                )
            })?
        }
    };
    check_remote_url_policy(&resolved, ErrorCode::InvalidPackage)?;
    if final_manifest_url.scheme() == "https" && resolved.scheme() != "https" {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Refusing HTTPS-to-HTTP artifact URL downgrade.",
        ));
    }
    Ok(resolved)
}

pub(crate) fn load_manifest(
    location: &ManifestLocation,
    network_policy: NetworkPolicy,
    transfer_policy: &TransferPolicy,
) -> Result<LoadedManifest, ClecError> {
    match location {
        ManifestLocation::LocalPath(raw_path) => {
            let manifest_path = fs::canonicalize(raw_path).map_err(|e| {
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
        ManifestLocation::RemoteUrl(url) => {
            if network_policy == NetworkPolicy::Offline {
                return Err(ClecError::new(
                    ErrorCode::OfflineRequired,
                    format!(
                        "Remote manifest {} is forbidden under --offline.",
                        redact_url_for_error(url)
                    ),
                ));
            }
            let persistent_origin = url.as_str().to_owned();
            let deadline = Instant::now() + transfer_policy.manifest_timeout;
            #[cfg(any(test, feature = "test-hooks"))]
            let hooks = current_test_hooks();

            let (mut transfer, mut safe_url) = start_get_transfer(
                url,
                TransferPhase::Manifest,
                deadline,
                (MAX_MANIFEST_BYTES as u64) + 1,
                transfer_policy,
                #[cfg(any(test, feature = "test-hooks"))]
                hooks.clone(),
            )?;

            let (final_url, content_length) =
                recv_get_head(&mut transfer, TransferPhase::Manifest, &mut safe_url)?;
            if let Some(len) = content_length
                && len > MAX_MANIFEST_BYTES as u64
            {
                return Err(ClecError::new(
                    ErrorCode::InvalidManifest,
                    "Manifest exceeds 1 MiB limit.",
                ));
            }

            let mut manifest_raw = Vec::new();
            loop {
                match transfer
                    .recv_event()
                    .map_err(|err| map_transport_failure(err, TransferPhase::Manifest, &safe_url))?
                {
                    TransferEvent::Chunk(chunk) => {
                        #[cfg(any(test, feature = "test-hooks"))]
                        if let Some(cb) = hooks.on_chunk_consumed.as_ref() {
                            cb(chunk.len());
                        }
                        if manifest_raw.len() + chunk.len() > MAX_MANIFEST_BYTES {
                            return Err(ClecError::new(
                                ErrorCode::InvalidManifest,
                                "Manifest exceeds 1 MiB limit.",
                            ));
                        }
                        manifest_raw.extend_from_slice(&chunk);
                    }
                    TransferEvent::Finished(Ok(())) => break,
                    TransferEvent::Finished(Err(err)) => {
                        return Err(map_transport_failure(
                            err,
                            TransferPhase::Manifest,
                            &safe_url,
                        ));
                    }
                    TransferEvent::Head { .. } => {
                        return Err(ClecError::new(
                            ErrorCode::TransferFailed,
                            "Unexpected duplicate response header during manifest transfer.",
                        ));
                    }
                }
            }
            drop(transfer);

            let manifest: ReleaseManifest = serde_json::from_slice(&manifest_raw).map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Invalid manifest JSON: {e}"),
                )
            })?;
            validate_manifest_fields(&manifest)?;
            let artifact_url = resolve_remote_artifact_url(&manifest, &final_url)?;
            Ok(LoadedManifest {
                manifest,
                persistent_origin,
                artifact: ArtifactLocation::RemoteUrl(artifact_url),
            })
        }
    }
}

pub(crate) fn acquire_artifact(
    loaded: &LoadedManifest,
    data_dir: &Path,
    network_policy: NetworkPolicy,
    transfer_policy: &TransferPolicy,
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
            Ok(AcquiredArtifact(AcquiredKind::Local(artifact_path.clone())))
        }
        ArtifactLocation::RemoteUrl(url) => {
            if network_policy == NetworkPolicy::Offline {
                return Err(ClecError::new(
                    ErrorCode::OfflineRequired,
                    format!(
                        "Remote artifact {} is forbidden under --offline.",
                        redact_url_for_error(url)
                    ),
                ));
            }

            let expected_bytes = loaded.manifest.compressed_bytes;
            let deadline = Instant::now() + transfer_policy.artifact_timeout;
            #[cfg(any(test, feature = "test-hooks"))]
            let hooks = current_test_hooks();

            let (mut transfer, mut safe_url) = start_get_transfer(
                url,
                TransferPhase::Artifact,
                deadline,
                expected_bytes.saturating_add(1),
                transfer_policy,
                #[cfg(any(test, feature = "test-hooks"))]
                hooks.clone(),
            )?;

            let (_, content_length) =
                recv_get_head(&mut transfer, TransferPhase::Artifact, &mut safe_url)?;
            if let Some(declared_len) = content_length
                && declared_len != expected_bytes
            {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    format!(
                        "Artifact Content-Length ({declared_len}) does not match manifest compressedBytes ({expected_bytes})."
                    ),
                ));
            }

            let temp_path = data_dir.join(STAGING_ARTIFACT_TEMP_NAME);
            let _ = fs::remove_file(&temp_path);
            let mut dst = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp_path)
                .map_err(map_io)?;
            let guard = RemoteTempGuard {
                path: temp_path.clone(),
            };

            let mut hasher = Sha256::new();
            let mut total = 0u64;
            loop {
                match transfer
                    .recv_event()
                    .map_err(|err| map_transport_failure(err, TransferPhase::Artifact, &safe_url))?
                {
                    TransferEvent::Chunk(chunk) => {
                        #[cfg(any(test, feature = "test-hooks"))]
                        if let Some(cb) = hooks.on_chunk_consumed.as_ref() {
                            cb(chunk.len());
                        }
                        let Some(next_total) = total.checked_add(chunk.len() as u64) else {
                            return Err(ClecError::new(
                                ErrorCode::IntegrityMismatch,
                                "Remote compressed artifact exceeds manifest compressedBytes.",
                            ));
                        };
                        if next_total > expected_bytes {
                            return Err(ClecError::new(
                                ErrorCode::IntegrityMismatch,
                                "Remote compressed artifact exceeds manifest compressedBytes.",
                            ));
                        }
                        total = next_total;
                        hasher.update(&chunk);
                        dst.write_all(&chunk).map_err(map_io)?;
                    }
                    TransferEvent::Finished(Ok(())) => break,
                    TransferEvent::Finished(Err(err)) => {
                        return Err(map_transport_failure(
                            err,
                            TransferPhase::Artifact,
                            &safe_url,
                        ));
                    }
                    TransferEvent::Head { .. } => {
                        return Err(ClecError::new(
                            ErrorCode::TransferFailed,
                            "Unexpected duplicate response header during artifact transfer.",
                        ));
                    }
                }
            }
            drop(transfer);

            if total != expected_bytes {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    format!(
                        "Remote compressed artifact ended at {total} bytes; expected {expected_bytes}."
                    ),
                ));
            }
            dst.flush().map_err(map_io)?;
            drop(dst);

            let actual_sha = hex_encode(&hasher.finalize());
            if actual_sha != loaded.manifest.compressed_sha256 {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "Remote compressed artifact SHA-256 does not match manifest.",
                ));
            }

            Ok(AcquiredArtifact(AcquiredKind::RemoteTemp {
                path: temp_path,
                _guard: guard,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_transport::{
        TestTransferHooks, install_test_hooks_guard, system_resolve_for_test,
    };
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Cursor};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;

    struct TestLatch {
        entered: Mutex<usize>,
        entered_cv: Condvar,
        released: Mutex<bool>,
        released_cv: Condvar,
    }

    impl TestLatch {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                entered: Mutex::new(0),
                entered_cv: Condvar::new(),
                released: Mutex::new(false),
                released_cv: Condvar::new(),
            })
        }

        fn arrive_and_wait(&self, max_wait: Duration) {
            {
                let mut count = self.entered.lock().unwrap();
                *count += 1;
                self.entered_cv.notify_all();
            }
            let mut rel = self.released.lock().unwrap();
            let deadline = Instant::now() + max_wait;
            while !*rel {
                let rem = deadline.saturating_duration_since(Instant::now());
                if rem.is_zero() {
                    break;
                }
                let (guard, timeout_res) = self.released_cv.wait_timeout(rel, rem).unwrap();
                rel = guard;
                if timeout_res.timed_out() {
                    break;
                }
            }
        }

        fn wait_entered(&self, min_count: usize, timeout: Duration) -> bool {
            let mut count = self.entered.lock().unwrap();
            let deadline = Instant::now() + timeout;
            while *count < min_count {
                let rem = deadline.saturating_duration_since(Instant::now());
                if rem.is_zero() {
                    return false;
                }
                let (guard, timeout_res) = self.entered_cv.wait_timeout(count, rem).unwrap();
                count = guard;
                if timeout_res.timed_out() {
                    return *count >= min_count;
                }
            }
            true
        }

        fn is_released(&self) -> bool {
            *self.released.lock().unwrap()
        }

        fn release(&self) {
            let mut rel = self.released.lock().unwrap();
            *rel = true;
            self.released_cv.notify_all();
        }
    }

    struct ExitSignal {
        count: Mutex<usize>,
        cv: Condvar,
    }

    impl ExitSignal {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                count: Mutex::new(0),
                cv: Condvar::new(),
            })
        }

        fn signal(&self) {
            let mut c = self.count.lock().unwrap();
            *c += 1;
            self.cv.notify_all();
        }

        fn wait_for(&self, target: usize, timeout: Duration) -> bool {
            let mut c = self.count.lock().unwrap();
            let deadline = Instant::now() + timeout;
            while *c < target {
                let rem = deadline.saturating_duration_since(Instant::now());
                if rem.is_zero() {
                    return false;
                }
                let (guard, timeout_res) = self.cv.wait_timeout(c, rem).unwrap();
                c = guard;
                if timeout_res.timed_out() {
                    return *c >= target;
                }
            }
            true
        }
    }

    enum MockRoute {
        Bytes {
            status: u16,
            headers: Vec<(String, String)>,
            body: Vec<u8>,
            delay: Duration,
        },
        Redirect {
            location: String,
            delay: Duration,
        },
    }

    struct LocalHttpServer {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<String>>>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl LocalHttpServer {
        fn start(bind_addr: &str, routes: HashMap<String, MockRoute>) -> Self {
            let listener = TcpListener::bind(bind_addr).unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let req_log = Arc::clone(&requests);
            let routes = Arc::new(routes);
            let handle = thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        continue;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" || h == "\n" {
                            break;
                        }
                    }
                    if path == "/__shutdown" {
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
                        break;
                    }
                    req_log.lock().unwrap().push(path.clone());
                    let key = path.split('?').next().unwrap_or(&path);
                    match routes.get(key) {
                        Some(MockRoute::Bytes {
                            status,
                            headers,
                            body,
                            delay,
                        }) => {
                            if !delay.is_zero() {
                                thread::sleep(*delay);
                            }
                            let mut head = format!(
                                "HTTP/1.1 {status} OK\r\nConnection: close\r\nContent-Length: {}\r\n",
                                body.len()
                            );
                            for (k, v) in headers {
                                head.push_str(&format!("{k}: {v}\r\n"));
                            }
                            head.push_str("\r\n");
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(body);
                            let _ = stream.flush();
                        }
                        Some(MockRoute::Redirect { location, delay }) => {
                            if !delay.is_zero() {
                                thread::sleep(*delay);
                            }
                            let head = format!(
                                "HTTP/1.1 302 Found\r\nConnection: close\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.flush();
                        }
                        None => {
                            let _ = stream.write_all(
                                b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                            );
                        }
                    }
                }
            });
            Self {
                addr,
                requests,
                handle: Some(handle),
            }
        }

        fn port(&self) -> u16 {
            self.addr.port()
        }

        fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for LocalHttpServer {
        fn drop(&mut self) {
            if let Ok(mut stream) = std::net::TcpStream::connect(self.addr) {
                let _ = stream.write_all(b"GET /__shutdown HTTP/1.1\r\nHost: localhost\r\n\r\n");
            }
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    struct LocalTlsServer {
        port: u16,
        ca_pem: Vec<u8>,
        req_log_path: PathBuf,
        child: Child,
    }

    impl LocalTlsServer {
        fn start(dir: &Path, san_spec: &str, routes: Vec<(&str, Vec<u8>)>) -> Self {
            let ca_crt = dir.join("ca.crt");
            let ca_key = dir.join("ca.key");
            let ca_cnf = dir.join("ca.cnf");
            fs::write(
                &ca_cnf,
                "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=CLEC Unit Test CA\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
            )
            .unwrap();
            assert!(
                Command::new("openssl")
                    .args([
                        "req",
                        "-x509",
                        "-newkey",
                        "rsa:2048",
                        "-nodes",
                        "-keyout",
                        &ca_key.display().to_string(),
                        "-out",
                        &ca_crt.display().to_string(),
                        "-days",
                        "2",
                        "-config",
                        &ca_cnf.display().to_string(),
                    ])
                    .output()
                    .unwrap()
                    .status
                    .success()
            );

            let leaf_key = dir.join("leaf.key");
            let leaf_csr = dir.join("leaf.csr");
            let leaf_crt = dir.join("leaf.crt");
            let leaf_cnf = dir.join("leaf.cnf");
            let leaf_ext = dir.join("leaf_ext.cnf");
            fs::write(
                &leaf_cnf,
                "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=clec-test\n",
            )
            .unwrap();
            fs::write(
                &leaf_ext,
                format!(
                    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName={san_spec}\n"
                ),
            )
            .unwrap();
            assert!(
                Command::new("openssl")
                    .args([
                        "req",
                        "-newkey",
                        "rsa:2048",
                        "-nodes",
                        "-keyout",
                        &leaf_key.display().to_string(),
                        "-out",
                        &leaf_csr.display().to_string(),
                        "-config",
                        &leaf_cnf.display().to_string(),
                    ])
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
            assert!(
                Command::new("openssl")
                    .args([
                        "x509",
                        "-req",
                        "-in",
                        &leaf_csr.display().to_string(),
                        "-CA",
                        &ca_crt.display().to_string(),
                        "-CAkey",
                        &ca_key.display().to_string(),
                        "-CAcreateserial",
                        "-out",
                        &leaf_crt.display().to_string(),
                        "-days",
                        "2",
                        "-extfile",
                        &leaf_ext.display().to_string(),
                    ])
                    .output()
                    .unwrap()
                    .status
                    .success()
            );

            let req_log_path = dir.join("tls_requests.log");
            let mut route_entries = serde_json::Map::new();
            for (idx, (path, body)) in routes.into_iter().enumerate() {
                let body_file = dir.join(format!("route_{idx}.bin"));
                fs::write(&body_file, &body).unwrap();
                route_entries.insert(
                    path.to_owned(),
                    serde_json::Value::String(body_file.display().to_string()),
                );
            }
            let routes_json = serde_json::Value::Object(route_entries).to_string();
            let routes_path = dir.join("routes.json");
            fs::write(&routes_path, routes_json).unwrap();

            let script = r#"
import json, ssl, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

cert, key, routes_path, req_log = sys.argv[1:5]
routes = json.loads(Path(routes_path).read_text())

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        return
    def do_GET(self):
        with open(req_log, "a") as f:
            f.write(self.path + "\n")
        key_path = self.path.split("?", 1)[0]
        body_path = routes.get(key_path)
        if body_path is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = Path(body_path).read_bytes()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(f"READY {srv.server_address[1]}", flush=True)
srv.serve_forever()
"#;
            let mut child = Command::new("python3")
                .args([
                    "-c",
                    script,
                    &leaf_crt.display().to_string(),
                    &leaf_key.display().to_string(),
                    &routes_path.display().to_string(),
                    &req_log_path.display().to_string(),
                ])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap());
            let mut line = String::new();
            stdout.read_line(&mut line).unwrap();
            let port: u16 = line
                .trim()
                .strip_prefix("READY ")
                .expect("TLS test server failed to start")
                .parse()
                .unwrap();
            let ca_pem = fs::read(&ca_crt).unwrap();
            Self {
                port,
                ca_pem,
                req_log_path,
                child,
            }
        }

        fn request_count(&self) -> usize {
            fs::read_to_string(&self.req_log_path)
                .map(|s| s.lines().count())
                .unwrap_or(0)
        }
    }

    impl Drop for LocalTlsServer {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn publish_fixture_release(
        dir: &Path,
        text: &str,
    ) -> (PathBuf, ReleaseManifest, Vec<u8>, Vec<u8>) {
        let ws = dir.join("ws");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), text).unwrap();
        let intake = dir.join("intake.json");
        fs::write(
            &intake,
            r#"{"schemaVersion":1,"works":[{"key":"w1","title":"W1"}],"sources":[{"work":"w1","path":"a.txt","title":"A","role":"document","attribution":"authored_fixture","quality":"fixture","status":"ready"}]}"#,
        )
        .unwrap();
        let rel = dir.join("rel");
        let manifest = crate::snapshot::publish_release(&ws, &intake, &rel).unwrap();
        let manifest_bytes = fs::read(rel.join("manifest.json")).unwrap();
        let zst_bytes = fs::read(rel.join("corpus.sqlite.zst")).unwrap();
        (rel, manifest, manifest_bytes, zst_bytes)
    }

    fn fast_policy(timeout_ms: u64, ca_pem: Option<Vec<u8>>) -> TransferPolicy {
        TransferPolicy {
            connect_timeout: Duration::from_secs(10),
            manifest_timeout: Duration::from_millis(timeout_ms),
            artifact_timeout: Duration::from_millis(timeout_ms),
            extra_root_pem: ca_pem,
        }
    }

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
        assert_eq!(
            ManifestLocation::parse("file://localhost/tmp/manifest.json").unwrap(),
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
            ManifestLocation::parse("http://[::1]:8080/manifest.json").unwrap(),
            ManifestLocation::RemoteUrl(_)
        ));
        assert!(matches!(
            ManifestLocation::parse("https://example.com/manifest.json").unwrap(),
            ManifestLocation::RemoteUrl(_)
        ));
    }

    #[test]
    fn localhost_loopback_resolver_rejects_any_non_loopback_address() {
        let url = Url::parse("http://localhost:8080/manifest.json").unwrap();
        let ok = ensure_localhost_loopback_with(&url, |_, port| {
            Ok(vec![
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
            ])
        });
        assert!(ok.is_ok());

        let mixed = ensure_localhost_loopback_with(&url, |_, port| {
            Ok(vec![
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)), port),
            ])
        });
        assert_eq!(mixed.unwrap_err().code, ErrorCode::TransferFailed);

        let empty = ensure_localhost_loopback_with(&url, |_, _| Ok(Vec::new()));
        assert_eq!(empty.unwrap_err().code, ErrorCode::TransferFailed);
    }

    #[test]
    fn redact_url_strips_query_and_userinfo() {
        let signed =
            Url::parse("https://user:pw@cdn.example.com:8443/a/b?X-Amz-Signature=secret#f")
                .unwrap();
        assert_eq!(
            redact_url_for_error(&signed),
            "https://cdn.example.com:8443/a/b"
        );
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

    #[test]
    fn in_process_resolver_latch_returns_before_dns_releases_and_sends_no_late_requests_http_and_https()
     {
        let tmp = tempfile::tempdir().unwrap();
        let (_, _, manifest_bytes, _) =
            publish_fixture_release(tmp.path(), "dns latch fixture content");

        let mut routes = HashMap::new();
        routes.insert(
            "/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: manifest_bytes.clone(),
                delay: Duration::ZERO,
            },
        );
        let http_srv = LocalHttpServer::start("127.0.0.1:0", routes);
        let tls_dir = tmp.path().join("tls");
        fs::create_dir_all(&tls_dir).unwrap();
        let tls_srv = LocalTlsServer::start(
            &tls_dir,
            "DNS:localhost,IP:127.0.0.1",
            vec![("/manifest.json", manifest_bytes)],
        );

        for (scheme, port, ca) in [
            ("http", http_srv.port(), None),
            ("https", tls_srv.port, Some(tls_srv.ca_pem.clone())),
        ] {
            let latch = TestLatch::new();
            let exit_sig = ExitSignal::new();
            let resolved_hosts = Arc::new(Mutex::new(Vec::new()));
            let latch_cb = Arc::clone(&latch);
            let exit_cb = Arc::clone(&exit_sig);
            let hosts_cb = Arc::clone(&resolved_hosts);

            let _guard = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(move |host, port| {
                    hosts_cb.lock().unwrap().push(host.to_owned());
                    latch_cb.arrive_and_wait(Duration::from_millis(1500));
                    system_resolve_for_test(host, port)
                })),
                worker_exit_hook: Some(Arc::new(move || exit_cb.signal())),
                ..Default::default()
            });

            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("{scheme}://localhost:{port}/manifest.json")).unwrap(),
            );
            let t0 = Instant::now();
            let err =
                load_manifest(&loc, NetworkPolicy::Allowed, &fast_policy(100, ca)).unwrap_err();
            let elapsed = t0.elapsed();

            assert_eq!(err.code, ErrorCode::TransferTimeout, "scheme={scheme}");
            assert!(
                elapsed < Duration::from_millis(600),
                "scheme={scheme} expected timeout well under 1.5s latch, took {elapsed:?}"
            );
            assert!(
                !latch.is_released(),
                "scheme={scheme} caller returned only after safety timeout"
            );
            assert!(
                latch.wait_entered(1, Duration::from_millis(500)),
                "scheme={scheme} resolver hook was never entered"
            );
            assert_eq!(resolved_hosts.lock().unwrap().as_slice(), ["localhost"]);

            thread::sleep(Duration::from_millis(50));
            latch.release();
            assert!(
                exit_sig.wait_for(1, Duration::from_secs(2)),
                "scheme={scheme} detached worker did not finish after latch release"
            );
        }

        assert_eq!(http_srv.request_count(), 0);
        assert_eq!(tls_srv.request_count(), 0);
    }

    #[test]
    fn active_a_preserved_and_sync_lock_reacquirable_while_b_dns_is_blocked() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, man_a, m_a_bytes, z_a_bytes) =
            publish_fixture_release(&tmp.path().join("pkg_a"), "alpha release A");
        let (_, _, m_b_bytes, z_b_bytes) =
            publish_fixture_release(&tmp.path().join("pkg_b"), "beta release B");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let reserved_port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut m_b_split: serde_json::Value = serde_json::from_slice(&m_b_bytes).unwrap();
        m_b_split["artifactUrl"] = serde_json::Value::String(format!(
            "http://localhost:{reserved_port}/b/corpus.sqlite.zst"
        ));
        let split_manifest_bytes = serde_json::to_vec(&m_b_split).unwrap();

        let mut routes = HashMap::new();
        routes.insert(
            "/a/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: m_a_bytes,
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/a/corpus.sqlite.zst".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: z_a_bytes,
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/b/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: m_b_bytes,
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/b/split-manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: split_manifest_bytes,
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/b/corpus.sqlite.zst".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: z_b_bytes,
                delay: Duration::ZERO,
            },
        );
        let srv = LocalHttpServer::start(&format!("127.0.0.1:{reserved_port}"), routes);
        let port = srv.port();

        let data_dir = tmp.path().join("data");
        let a_url = format!("http://127.0.0.1:{port}/a/manifest.json");
        crate::snapshot::sync_with_prepare(
            &data_dir,
            Some(&a_url),
            NetworkPolicy::Allowed,
            None,
            &TransferPolicy::shipped(),
            |d| Ok(d.clone()),
        )
        .unwrap();
        let active_before = fs::read(data_dir.join("active.json")).unwrap();
        let db_before = fs::read(data_dir.join(format!("{}.sqlite", man_a.sha256))).unwrap();

        let blocked_urls = [
            format!("http://localhost:{port}/b/manifest.json"),
            format!("http://127.0.0.1:{port}/b/split-manifest.json"),
        ];
        for (idx, blocked_url) in blocked_urls.iter().enumerate() {
            let l_iter = TestLatch::new();
            let e_iter = ExitSignal::new();
            let l_cb = Arc::clone(&l_iter);
            let e_cb = Arc::clone(&e_iter);
            let _guard = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(move |host, port| {
                    l_cb.arrive_and_wait(Duration::from_millis(1500));
                    system_resolve_for_test(host, port)
                })),
                worker_exit_hook: Some(Arc::new(move || e_cb.signal())),
                ..Default::default()
            });

            let t0 = Instant::now();
            let err = crate::snapshot::sync_with_prepare(
                &data_dir,
                Some(blocked_url),
                NetworkPolicy::Allowed,
                None,
                &fast_policy(120, None),
                |d| Ok(d.clone()),
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::TransferTimeout, "case={idx}");
            assert!(t0.elapsed() < Duration::from_millis(600), "case={idx}");
            assert!(!l_iter.is_released(), "case={idx}");
            assert!(
                l_iter.wait_entered(1, Duration::from_millis(500)),
                "case={idx}"
            );

            assert_eq!(
                fs::read(data_dir.join("active.json")).unwrap(),
                active_before
            );
            assert_eq!(
                fs::read(data_dir.join(format!("{}.sqlite", man_a.sha256))).unwrap(),
                db_before
            );
            assert!(!data_dir.join(STAGING_ARTIFACT_TEMP_NAME).exists());

            drop(_guard);
            let reacquired = crate::snapshot::sync_with_prepare(
                &data_dir,
                Some(&a_url),
                NetworkPolicy::Allowed,
                None,
                &TransferPolicy::shipped(),
                |d| Ok(d.clone()),
            )
            .unwrap();
            assert!(reacquired.reused);
            assert!(!l_iter.is_released());

            l_iter.release();
            assert!(e_iter.wait_for(1, Duration::from_secs(2)));
            assert_eq!(
                fs::read(data_dir.join("active.json")).unwrap(),
                active_before
            );
            assert_eq!(
                fs::read(data_dir.join(format!("{}.sqlite", man_a.sha256))).unwrap(),
                db_before
            );
            assert!(!data_dir.join(STAGING_ARTIFACT_TEMP_NAME).exists());
        }

        let reqs = srv.requests();
        assert!(
            !reqs
                .iter()
                .any(|p| p == "/b/manifest.json" || p == "/b/corpus.sqlite.zst"),
            "unexpected late requests to blocked B targets: {reqs:?}"
        );
    }

    #[test]
    fn offline_mode_spawns_zero_workers_zero_dns_and_zero_http_and_local_artifact_url_works() {
        let tmp = tempfile::tempdir().unwrap();
        let (rel, manifest, m_bytes, _) =
            publish_fixture_release(&tmp.path().join("pkg"), "offline local artifactUrl");
        let mut routes = HashMap::new();
        routes.insert(
            "/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: m_bytes,
                delay: Duration::ZERO,
            },
        );
        let srv = LocalHttpServer::start("127.0.0.1:0", routes);
        let port = srv.port();

        let worker_spawns = Arc::new(AtomicUsize::new(0));
        let dns_calls = Arc::new(AtomicUsize::new(0));
        let spawns_cb = Arc::clone(&worker_spawns);
        let dns_cb = Arc::clone(&dns_calls);

        let _guard = install_test_hooks_guard(TestTransferHooks {
            resolve_hook: Some(Arc::new(move |host, port| {
                dns_cb.fetch_add(1, Ordering::SeqCst);
                system_resolve_for_test(host, port)
            })),
            worker_spawn_hook: Some(Arc::new(move || {
                spawns_cb.fetch_add(1, Ordering::SeqCst);
            })),
            ..Default::default()
        });

        let remote_m = ManifestLocation::RemoteUrl(
            Url::parse(&format!("http://localhost:{port}/manifest.json")).unwrap(),
        );
        let err_m = load_manifest(
            &remote_m,
            NetworkPolicy::Offline,
            &TransferPolicy::shipped(),
        )
        .unwrap_err();
        assert_eq!(err_m.code, ErrorCode::OfflineRequired);

        let fake_loaded = LoadedManifest {
            manifest: manifest.clone(),
            persistent_origin: format!("http://localhost:{port}/manifest.json"),
            artifact: ArtifactLocation::RemoteUrl(
                Url::parse(&format!("http://localhost:{port}/corpus.sqlite.zst")).unwrap(),
            ),
        };
        let err_a = acquire_artifact(
            &fake_loaded,
            tmp.path(),
            NetworkPolicy::Offline,
            &TransferPolicy::shipped(),
        )
        .unwrap_err();
        assert_eq!(err_a.code, ErrorCode::OfflineRequired);

        let mut local_m: serde_json::Value =
            serde_json::from_slice(&fs::read(rel.join("manifest.json")).unwrap()).unwrap();
        local_m["artifactUrl"] =
            serde_json::Value::String(format!("http://localhost:{port}/must-not-fetch.zst"));
        let local_m_path = rel.join("manifest_with_url.json");
        fs::write(&local_m_path, serde_json::to_vec(&local_m).unwrap()).unwrap();
        let data_dir = tmp.path().join("data");
        let synced = crate::snapshot::sync_with_prepare(
            &data_dir,
            Some(&local_m_path.display().to_string()),
            NetworkPolicy::Offline,
            None,
            &TransferPolicy::shipped(),
            |d| Ok(d.clone()),
        )
        .unwrap();
        assert_eq!(synced.release, manifest.sha256);
        assert_eq!(worker_spawns.load(Ordering::SeqCst), 0);
        assert_eq!(dns_calls.load(Ordering::SeqCst), 0);
        assert_eq!(srv.request_count(), 0);
    }

    #[test]
    fn client_setup_and_pre_completion_cleanup_latches_enforce_deadline_and_finish_ordering() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, _, manifest_bytes, zst_bytes) =
            publish_fixture_release(tmp.path(), "setup and cleanup latches");
        let mut routes = HashMap::new();
        routes.insert(
            "/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: manifest_bytes,
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/corpus.sqlite.zst".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: zst_bytes,
                delay: Duration::ZERO,
            },
        );
        let srv = LocalHttpServer::start("127.0.0.1:0", routes);
        let port = srv.port();

        let setup_latch = TestLatch::new();
        let setup_exit = ExitSignal::new();
        let s_cb = Arc::clone(&setup_latch);
        let se_cb = Arc::clone(&setup_exit);
        {
            let _guard = install_test_hooks_guard(TestTransferHooks {
                client_setup_hook: Some(Arc::new(move || {
                    s_cb.arrive_and_wait(Duration::from_millis(1500));
                })),
                worker_exit_hook: Some(Arc::new(move || se_cb.signal())),
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("http://127.0.0.1:{port}/manifest.json")).unwrap(),
            );
            let t0 = Instant::now();
            let err =
                load_manifest(&loc, NetworkPolicy::Allowed, &fast_policy(100, None)).unwrap_err();
            assert_eq!(err.code, ErrorCode::TransferTimeout);
            assert!(t0.elapsed() < Duration::from_millis(600));
            assert!(!setup_latch.is_released());
            assert!(setup_latch.wait_entered(1, Duration::from_millis(500)));
            setup_latch.release();
            assert!(setup_exit.wait_for(1, Duration::from_secs(2)));
        }
        assert_eq!(srv.request_count(), 0);

        let cleanup_latch = TestLatch::new();
        let cleanup_exit = ExitSignal::new();
        let c_cb = Arc::clone(&cleanup_latch);
        let ce_cb = Arc::clone(&cleanup_exit);
        let data_dir = tmp.path().join("cleanup_data");
        {
            let _guard = install_test_hooks_guard(TestTransferHooks {
                pre_completion_cleanup_hook: Some(Arc::new(move || {
                    c_cb.arrive_and_wait(Duration::from_millis(1500));
                })),
                worker_exit_hook: Some(Arc::new(move || ce_cb.signal())),
                ..Default::default()
            });
            let t0 = Instant::now();
            let err = crate::snapshot::sync_with_prepare(
                &data_dir,
                Some(&format!("http://127.0.0.1:{port}/manifest.json")),
                NetworkPolicy::Allowed,
                None,
                &fast_policy(150, None),
                |d| Ok(d.clone()),
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::TransferTimeout);
            assert!(t0.elapsed() < Duration::from_millis(600));
            assert!(!cleanup_latch.is_released());
            assert!(cleanup_latch.wait_entered(1, Duration::from_millis(500)));
            cleanup_latch.release();
            assert!(cleanup_exit.wait_for(1, Duration::from_secs(2)));
        }
        assert!(!data_dir.join("active.json").exists());
        assert!(!data_dir.join(STAGING_ARTIFACT_TEMP_NAME).exists());
    }

    #[test]
    fn localhost_mixed_empty_pinned_sni_and_literal_zero_dns() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, manifest, manifest_bytes, _) =
            publish_fixture_release(tmp.path(), "sni and pinning test");
        let mut routes = HashMap::new();
        routes.insert(
            "/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: manifest_bytes.clone(),
                delay: Duration::ZERO,
            },
        );
        let srv = LocalHttpServer::start("127.0.0.1:0", routes);
        let port = srv.port();

        {
            let _mixed = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(|_, port| {
                    Ok(vec![
                        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)), port),
                    ])
                })),
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("http://localhost:{port}/manifest.json")).unwrap(),
            );
            let err = load_manifest(&loc, NetworkPolicy::Allowed, &TransferPolicy::shipped())
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::TransferFailed);
        }
        {
            let _empty = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(|_, _| Ok(Vec::new()))),
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("http://localhost:{port}/manifest.json")).unwrap(),
            );
            let err = load_manifest(&loc, NetworkPolicy::Allowed, &TransferPolicy::shipped())
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::TransferFailed);
        }
        assert_eq!(srv.request_count(), 0);

        let literal_dns = Arc::new(AtomicUsize::new(0));
        let ldns = Arc::clone(&literal_dns);
        {
            let _lit = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(move |host, port| {
                    ldns.fetch_add(1, Ordering::SeqCst);
                    system_resolve_for_test(host, port)
                })),
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("http://127.0.0.1:{port}/manifest.json")).unwrap(),
            );
            let loaded =
                load_manifest(&loc, NetworkPolicy::Allowed, &TransferPolicy::shipped()).unwrap();
            assert_eq!(loaded.manifest.sha256, manifest.sha256);
        }
        assert_eq!(literal_dns.load(Ordering::SeqCst), 0);

        let tls_dir = tmp.path().join("tls_sni");
        fs::create_dir_all(&tls_dir).unwrap();
        let tls_srv = LocalTlsServer::start(
            &tls_dir,
            "DNS:sni-pinned.clec.test",
            vec![("/manifest.json", manifest_bytes)],
        );
        let tls_calls = Arc::new(AtomicUsize::new(0));
        let tcalls = Arc::clone(&tls_calls);
        let tls_port = tls_srv.port;
        {
            let _pin = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(move |host, port| {
                    assert_eq!(host, "sni-pinned.clec.test");
                    assert_eq!(tcalls.fetch_add(1, Ordering::SeqCst), 0);
                    Ok(vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)])
                })),
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!(
                    "https://sni-pinned.clec.test:{tls_port}/manifest.json"
                ))
                .unwrap(),
            );
            let loaded = load_manifest(
                &loc,
                NetworkPolicy::Allowed,
                &fast_policy(5000, Some(tls_srv.ca_pem.clone())),
            )
            .unwrap();
            assert_eq!(loaded.manifest.sha256, manifest.sha256);
        }
        assert_eq!(tls_calls.load(Ordering::SeqCst), 1);
        assert_eq!(tls_srv.request_count(), 1);
    }

    #[test]
    fn bounded_backpressure_slow_consumer_early_reject_and_worker_disconnect_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let payload = vec![b'z'; 600 * 1024];
        let payload_sha = hex_encode(&Sha256::digest(&payload));
        let (_, mut manifest, m_bytes, _) =
            publish_fixture_release(&tmp.path().join("pkg"), "backpressure seed");
        manifest.compressed_bytes = payload.len() as u64;
        manifest.compressed_sha256 = payload_sha;

        let mut routes = HashMap::new();
        routes.insert(
            "/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: m_bytes,
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/big.zst".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: payload.clone(),
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/overrun.zst".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: vec![b'q'; 256 * 1024],
                delay: Duration::ZERO,
            },
        );
        let srv = LocalHttpServer::start("127.0.0.1:0", routes);
        let port = srv.port();

        let chunks_sent = Arc::new(AtomicUsize::new(0));
        let sent_ref = Arc::clone(&chunks_sent);
        let max_lead = Arc::new(AtomicUsize::new(0));
        let lead_ref = Arc::clone(&max_lead);
        let consumed = Arc::new(AtomicUsize::new(0));
        let cons_ref = Arc::clone(&consumed);
        {
            let _slow = install_test_hooks_guard(TestTransferHooks {
                chunks_sent_count: Some(Arc::clone(&chunks_sent)),
                on_chunk_consumed: Some(Arc::new(move |_len| {
                    let c = cons_ref.fetch_add(1, Ordering::SeqCst) + 1;
                    let s = sent_ref.load(Ordering::SeqCst);
                    lead_ref.fetch_max(s.saturating_sub(c), Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(20));
                })),
                ..Default::default()
            });
            let loaded = LoadedManifest {
                manifest: manifest.clone(),
                persistent_origin: format!("http://127.0.0.1:{port}/manifest.json"),
                artifact: ArtifactLocation::RemoteUrl(
                    Url::parse(&format!("http://127.0.0.1:{port}/big.zst")).unwrap(),
                ),
            };
            let data_dir = tmp.path().join("slow_data");
            fs::create_dir_all(&data_dir).unwrap();
            let acquired = acquire_artifact(
                &loaded,
                &data_dir,
                NetworkPolicy::Allowed,
                &fast_policy(10_000, None),
            )
            .unwrap();
            assert!(acquired.path().is_file());
            assert!(consumed.load(Ordering::SeqCst) >= 9);
            assert!(
                max_lead.load(Ordering::SeqCst) <= 2,
                "channel backpressure broken: max lead {}",
                max_lead.load(Ordering::SeqCst)
            );
        }

        let early_exit = ExitSignal::new();
        let ee_cb = Arc::clone(&early_exit);
        let early_data = tmp.path().join("early_data");
        fs::create_dir_all(&early_data).unwrap();
        {
            let _early = install_test_hooks_guard(TestTransferHooks {
                worker_exit_hook: Some(Arc::new(move || ee_cb.signal())),
                ..Default::default()
            });
            let loaded = LoadedManifest {
                manifest: manifest.clone(),
                persistent_origin: format!("http://127.0.0.1:{port}/manifest.json"),
                artifact: ArtifactLocation::RemoteUrl(
                    Url::parse(&format!("http://127.0.0.1:{port}/overrun.zst")).unwrap(),
                ),
            };
            let err = acquire_artifact(
                &loaded,
                &early_data,
                NetworkPolicy::Allowed,
                &fast_policy(5_000, None),
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::IntegrityMismatch);
            assert!(early_exit.wait_for(1, Duration::from_secs(2)));
            assert!(!early_data.join(STAGING_ARTIFACT_TEMP_NAME).exists());
        }

        {
            let _disc = install_test_hooks_guard(TestTransferHooks {
                drop_before_finished: true,
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("http://127.0.0.1:{port}/manifest.json")).unwrap(),
            );
            let err =
                load_manifest(&loc, NetworkPolicy::Allowed, &fast_policy(5_000, None)).unwrap_err();
            assert_eq!(err.code, ErrorCode::TransferFailed);
        }
    }

    #[test]
    fn per_hop_redirects_spawn_single_worker_and_share_one_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, manifest, m_bytes, _) =
            publish_fixture_release(tmp.path(), "redirect single worker test");
        let mut routes = HashMap::new();
        routes.insert(
            "/manifest.json".to_owned(),
            MockRoute::Bytes {
                status: 200,
                headers: Vec::new(),
                body: m_bytes,
                delay: Duration::ZERO,
            },
        );
        let srv = LocalHttpServer::start("127.0.0.1:0", HashMap::new());
        let port = srv.port();
        drop(srv);

        routes.insert(
            "/r1".to_owned(),
            MockRoute::Redirect {
                location: format!("http://localhost:{port}/r2"),
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/r2".to_owned(),
            MockRoute::Redirect {
                location: format!("http://127.0.0.1:{port}/r3"),
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/r3".to_owned(),
            MockRoute::Redirect {
                location: format!("http://localhost:{port}/r4"),
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/r4".to_owned(),
            MockRoute::Redirect {
                location: format!("http://127.0.0.1:{port}/r5"),
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/r5".to_owned(),
            MockRoute::Redirect {
                location: "/manifest.json".to_owned(),
                delay: Duration::ZERO,
            },
        );
        routes.insert(
            "/slow_lit".to_owned(),
            MockRoute::Redirect {
                location: format!("http://localhost:{port}/manifest.json"),
                delay: Duration::from_millis(120),
            },
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let real_port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut fixed_routes = HashMap::new();
        for (k, v) in routes {
            let v = match v {
                MockRoute::Redirect { location, delay } => MockRoute::Redirect {
                    location: location.replace(&format!(":{port}"), &format!(":{real_port}")),
                    delay,
                },
                other => other,
            };
            fixed_routes.insert(k, v);
        }
        let srv = LocalHttpServer::start(&format!("127.0.0.1:{real_port}"), fixed_routes);
        let port = srv.port();

        let worker_spawns = Arc::new(AtomicUsize::new(0));
        let ws_cb = Arc::clone(&worker_spawns);
        let dns_hosts = Arc::new(Mutex::new(Vec::new()));
        let dh_cb = Arc::clone(&dns_hosts);
        {
            let _guard = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(move |host, port| {
                    dh_cb.lock().unwrap().push(host.to_owned());
                    system_resolve_for_test(host, port)
                })),
                worker_spawn_hook: Some(Arc::new(move || {
                    ws_cb.fetch_add(1, Ordering::SeqCst);
                })),
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("http://127.0.0.1:{port}/r1")).unwrap(),
            );
            let loaded =
                load_manifest(&loc, NetworkPolicy::Allowed, &fast_policy(5_000, None)).unwrap();
            assert_eq!(loaded.manifest.sha256, manifest.sha256);
        }
        assert_eq!(worker_spawns.load(Ordering::SeqCst), 1);
        assert_eq!(
            dns_hosts.lock().unwrap().as_slice(),
            ["localhost", "localhost"]
        );

        let before_reqs = srv.request_count();
        let exit_sig = ExitSignal::new();
        let es_cb = Arc::clone(&exit_sig);
        {
            let _guard = install_test_hooks_guard(TestTransferHooks {
                resolve_hook: Some(Arc::new(move |host, port| {
                    thread::sleep(Duration::from_millis(120));
                    system_resolve_for_test(host, port)
                })),
                worker_exit_hook: Some(Arc::new(move || es_cb.signal())),
                ..Default::default()
            });
            let loc = ManifestLocation::RemoteUrl(
                Url::parse(&format!("http://127.0.0.1:{port}/slow_lit")).unwrap(),
            );
            let t0 = Instant::now();
            let err =
                load_manifest(&loc, NetworkPolicy::Allowed, &fast_policy(200, None)).unwrap_err();
            assert_eq!(err.code, ErrorCode::TransferTimeout);
            assert!(t0.elapsed() < Duration::from_millis(500));
            assert!(exit_sig.wait_for(1, Duration::from_secs(2)));
        }
        let after_reqs = srv.requests();
        assert_eq!(&after_reqs[before_reqs..], ["/slow_lit"]);
    }
}
