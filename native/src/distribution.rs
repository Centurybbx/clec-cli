use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::blocking::{Client, ClientBuilder, Response};
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, LOCATION};
use reqwest::{StatusCode, Url, redirect, retry};
use sha2::{Digest, Sha256};

use crate::domain::{
    CORPUS_FORMAT, ClecError, DICTIONARY_REVISION, EQUIVALENCE_REVISION, ErrorCode,
    NORMALIZATION_REVISION, SCHEMA_VERSION, SEGMENTATION_REVISION, TOKENIZATION_REVISION,
    hex_encode,
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

fn is_localhost_domain(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|h| h.eq_ignore_ascii_case("localhost"))
}

fn is_loopback_literal_host(host: &str) -> bool {
    if let Ok(v4) = host.parse::<Ipv4Addr>() {
        return v4.is_loopback();
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|s| s.strip_suffix(']'))
        && let Ok(v6) = inner.parse::<Ipv6Addr>()
    {
        return v6.is_loopback();
    }
    false
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

fn read_bounded_remote_manifest(
    mut resp: Response,
    max_bytes: usize,
    deadline: Instant,
    safe_url: &str,
) -> Result<Vec<u8>, ClecError> {
    if let Some(len) = resp.content_length()
        && len > max_bytes as u64
    {
        return Err(ClecError::new(
            ErrorCode::InvalidManifest,
            "Manifest exceeds 1 MiB limit.",
        ));
    }
    let mut out = Vec::new();
    let mut buf = [0u8; 16_384];
    loop {
        if Instant::now() >= deadline {
            return Err(ClecError::new(
                ErrorCode::TransferTimeout,
                format!("Manifest transfer timed out for {safe_url}."),
            ));
        }
        let remaining = max_bytes.saturating_sub(out.len()) + 1;
        let to_read = remaining.min(buf.len());
        let n = match resp.read(&mut buf[..to_read]) {
            Ok(n) => n,
            Err(e) => {
                return Err(classify_io_transfer_err(&e, deadline, "manifest", safe_url));
            }
        };
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

fn ensure_localhost_loopback_with<F>(
    url: &Url,
    resolver: F,
) -> Result<Option<Vec<SocketAddr>>, ClecError>
where
    F: FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
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

fn system_resolve(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    Ok((host, port).to_socket_addrs()?.collect())
}

fn build_http_client(
    policy: &TransferPolicy,
    localhost_addrs: Option<&[SocketAddr]>,
) -> Result<Client, ClecError> {
    let mut builder = ClientBuilder::new()
        .redirect(redirect::Policy::none())
        .retry(retry::never())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(policy.connect_timeout)
        .user_agent(concat!("clec/", env!("CARGO_PKG_VERSION")));

    if let Some(addrs) = localhost_addrs {
        builder = builder.resolve_to_addrs("localhost", addrs);
    }

    #[cfg(any(test, feature = "test-hooks"))]
    if let Some(pem) = policy.extra_root_pem.as_deref() {
        let certs = reqwest::Certificate::from_pem_bundle(pem).map_err(|e| {
            ClecError::new(
                ErrorCode::InternalError,
                format!("Invalid fixture root certificate PEM: {e}"),
            )
        })?;
        builder = builder.tls_certs_merge(certs);
    }

    builder.build().map_err(|e| {
        ClecError::new(
            ErrorCode::TransferFailed,
            format!("HTTP client initialization failed: {}", e.without_url()),
        )
    })
}

fn is_reqwest_timeout(err: &reqwest::Error) -> bool {
    if err.is_timeout() {
        return true;
    }
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        if let Some(io_err) = cause.downcast_ref::<io::Error>()
            && io_err.kind() == io::ErrorKind::TimedOut
        {
            return true;
        }
        if let Some(req_err) = cause.downcast_ref::<reqwest::Error>()
            && req_err.is_timeout()
        {
            return true;
        }
        source = cause.source();
    }
    false
}

fn classify_reqwest_err(
    err: reqwest::Error,
    deadline: Instant,
    phase: &str,
    safe_url: &str,
) -> ClecError {
    let timed_out = is_reqwest_timeout(&err) || Instant::now() >= deadline;
    let stripped = err.without_url();
    if timed_out {
        ClecError::new(
            ErrorCode::TransferTimeout,
            format!("{phase} transfer timed out for {safe_url}: {stripped}"),
        )
    } else {
        ClecError::new(
            ErrorCode::TransferFailed,
            format!("{phase} transfer failed for {safe_url}: {stripped}"),
        )
    }
}

fn classify_io_transfer_err(
    err: &io::Error,
    deadline: Instant,
    phase: &str,
    safe_url: &str,
) -> ClecError {
    let reqwest_timeout = err
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<reqwest::Error>())
        .is_some_and(is_reqwest_timeout);
    if err.kind() == io::ErrorKind::TimedOut || reqwest_timeout || Instant::now() >= deadline {
        ClecError::new(
            ErrorCode::TransferTimeout,
            format!("{phase} transfer timed out for {safe_url}."),
        )
    } else {
        ClecError::new(
            ErrorCode::TransferFailed,
            format!("{phase} transfer failed for {safe_url}: {err}"),
        )
    }
}

fn is_redirect_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn validate_response_encoding(
    resp: &Response,
    phase: &str,
    safe_url: &str,
) -> Result<(), ClecError> {
    for val in resp.headers().get_all(CONTENT_ENCODING) {
        let s = val.to_str().map_err(|_| {
            ClecError::new(
                ErrorCode::TransferFailed,
                format!("Invalid Content-Encoding header during {phase} fetch from {safe_url}."),
            )
        })?;
        for part in s.split(',') {
            let trimmed = part.trim();
            if !trimmed.eq_ignore_ascii_case("identity") {
                return Err(ClecError::new(
                    ErrorCode::TransferFailed,
                    format!(
                        "Unsupported Content-Encoding '{trimmed}' during {phase} fetch from {safe_url}; expected identity."
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn fetch_with_manual_redirects(
    initial_url: &Url,
    policy: &TransferPolicy,
    total_timeout: Duration,
    phase: &str,
) -> Result<(Response, Url, Instant), ClecError> {
    let deadline = Instant::now() + total_timeout;
    let mut current_url = initial_url.clone();
    let mut localhost_addrs = ensure_localhost_loopback_with(&current_url, system_resolve)?;
    let mut client = build_http_client(policy, localhost_addrs.as_deref())?;

    for hop in 0..=MAX_REDIRECTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ClecError::new(
                ErrorCode::TransferTimeout,
                format!(
                    "{phase} transfer timed out for {}.",
                    redact_url_for_error(&current_url)
                ),
            ));
        }

        let safe_url = redact_url_for_error(&current_url);
        let resp = client
            .get(current_url.clone())
            .header(ACCEPT_ENCODING, "identity")
            .timeout(remaining)
            .send()
            .map_err(|e| classify_reqwest_err(e, deadline, phase, &safe_url))?;

        if current_url.scheme() == "http"
            && let Some(remote_addr) = resp.remote_addr()
            && !remote_addr.ip().is_loopback()
        {
            return Err(ClecError::new(
                ErrorCode::TransferFailed,
                format!("Plain HTTP connected to non-loopback address for {safe_url}."),
            ));
        }

        let status = resp.status();
        if is_redirect_status(status) {
            if hop == MAX_REDIRECTS {
                return Err(ClecError::new(
                    ErrorCode::TransferFailed,
                    format!(
                        "Exceeded maximum of {MAX_REDIRECTS} HTTP redirects during {phase} fetch from {safe_url}."
                    ),
                ));
            }
            let location_header = resp.headers().get(LOCATION).ok_or_else(|| {
                ClecError::new(
                    ErrorCode::TransferFailed,
                    format!("HTTP {status} redirect missing Location header from {safe_url}."),
                )
            })?;
            let location_str = location_header.to_str().map_err(|_| {
                ClecError::new(
                    ErrorCode::TransferFailed,
                    format!("Invalid redirect Location header from {safe_url}."),
                )
            })?;
            if location_str.contains('#') {
                return Err(ClecError::new(
                    ErrorCode::TransferFailed,
                    format!("Redirect target from {safe_url} must not contain a URL fragment."),
                ));
            }
            let next_url = current_url.join(location_str).map_err(|_| {
                ClecError::new(
                    ErrorCode::TransferFailed,
                    format!("Malformed redirect Location header from {safe_url}."),
                )
            })?;
            check_remote_url_policy(&next_url, ErrorCode::TransferFailed)?;
            if current_url.scheme() == "https" && next_url.scheme() != "https" {
                return Err(ClecError::new(
                    ErrorCode::TransferFailed,
                    format!("Refusing HTTPS-to-HTTP redirect downgrade from {safe_url}."),
                ));
            }
            if next_url.scheme() == "http"
                && next_url
                    .host_str()
                    .is_some_and(|h| h.eq_ignore_ascii_case("localhost"))
                && localhost_addrs.is_none()
            {
                localhost_addrs = ensure_localhost_loopback_with(&next_url, system_resolve)?;
                client = build_http_client(policy, localhost_addrs.as_deref())?;
            }
            drop(resp);
            current_url = next_url;
            continue;
        }

        if status != StatusCode::OK {
            return Err(ClecError::new(
                ErrorCode::TransferFailed,
                format!(
                    "HTTP {} during {phase} fetch from {safe_url}.",
                    status.as_u16()
                ),
            ));
        }

        validate_response_encoding(&resp, phase, &safe_url)?;
        return Ok((resp, current_url, deadline));
    }

    Err(ClecError::new(
        ErrorCode::TransferFailed,
        format!("Redirect loop exceeded during {phase} fetch."),
    ))
}

fn resolve_remote_artifact_url(
    manifest: &ReleaseManifest,
    final_manifest_url: &Url,
) -> Result<Url, ClecError> {
    let resolved = match manifest.artifact_url.as_deref() {
        Some(raw) => validate_remote_url(raw, ErrorCode::InvalidPackage)?,
        None => {
            let _ = validate_relative_path(&manifest.artifact)?;
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
            let (resp, final_url, deadline) = fetch_with_manual_redirects(
                url,
                transfer_policy,
                transfer_policy.manifest_timeout,
                "manifest",
            )?;
            let safe_final = redact_url_for_error(&final_url);
            let manifest_raw =
                read_bounded_remote_manifest(resp, MAX_MANIFEST_BYTES, deadline, &safe_final)?;
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

            let (mut resp, final_url, deadline) = fetch_with_manual_redirects(
                url,
                transfer_policy,
                transfer_policy.artifact_timeout,
                "artifact",
            )?;
            let safe_final = redact_url_for_error(&final_url);
            let expected_bytes = loaded.manifest.compressed_bytes;
            if let Some(declared_len) = resp.content_length()
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
            let mut buf = [0u8; 65_536];
            let mut total = 0u64;
            loop {
                if Instant::now() >= deadline {
                    return Err(ClecError::new(
                        ErrorCode::TransferTimeout,
                        format!("Artifact transfer timed out for {safe_final}."),
                    ));
                }
                let n = match resp.read(&mut buf) {
                    Ok(n) => n,
                    Err(e) => {
                        return Err(classify_io_transfer_err(
                            &e,
                            deadline,
                            "artifact",
                            &safe_final,
                        ));
                    }
                };
                if n == 0 {
                    break;
                }
                let Some(next_total) = total.checked_add(n as u64) else {
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
                hasher.update(&buf[..n]);
                dst.write_all(&buf[..n]).map_err(map_io)?;
            }

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
    use std::io::Cursor;
    use std::net::IpAddr;

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
}
