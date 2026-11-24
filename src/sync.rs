use std::{
    fs::{self, File},
    io::{self, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{metadata::Metadata, reader::Snapshot};

pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/Centurybbx/clec-corpus/releases/latest/download/manifest.json";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_DOWNLOAD_ATTEMPTS: u8 = 2;

pub struct SyncOptions<'a> {
    pub manifest_url: &'a str,
    pub index_dir: &'a Path,
    pub force: bool,
    pub check: bool,
}

pub fn run(options: &SyncOptions<'_>, out: &mut impl Write, human: bool) -> Result<()> {
    let manifest = fetch_manifest(&http_agent(MANIFEST_TIMEOUT), options.manifest_url)?;
    let local = local_version(options.index_dir);
    let availability = availability(local.as_deref(), &manifest.pack_version);

    if options.check {
        if human {
            write_check_human(out, availability, local.as_deref(), &manifest)?;
        } else {
            write_json(
                out,
                &CheckReport {
                    status: availability.as_str(),
                    local_version: local.as_deref(),
                    remote_version: &manifest.pack_version,
                    archive_url: &manifest.archive_url,
                    size_bytes: manifest.size_bytes,
                    sha256: &manifest.sha256,
                },
            )?;
        }
        return Ok(());
    }

    if availability == Availability::UpToDate && !options.force {
        if human {
            writeln!(
                out,
                "clec pack {} is up to date at {}",
                manifest.pack_version,
                options.index_dir.display()
            )?;
        } else {
            write_json(
                out,
                &UpToDateReport {
                    status: availability.as_str(),
                    version: &manifest.pack_version,
                    index_dir: &options.index_dir.display().to_string(),
                },
            )?;
        }
        return Ok(());
    }

    install(&manifest, options.index_dir)?;

    if human {
        writeln!(
            out,
            "Synced clec pack {} to {} ({})",
            manifest.pack_version,
            options.index_dir.display(),
            format_size(manifest.size_bytes)
        )?;
    } else {
        write_json(
            out,
            &SyncedReport {
                status: "synced",
                version: &manifest.pack_version,
                index_dir: &options.index_dir.display().to_string(),
                size_bytes: manifest.size_bytes,
            },
        )?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct Manifest {
    schema_version: u32,
    pack_version: String,
    archive_url: String,
    #[serde(default)]
    mirrors: Vec<String>,
    sha256: String,
    size_bytes: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Availability {
    NotInstalled,
    UpToDate,
    UpdateAvailable,
}

impl Availability {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotInstalled => "not_installed",
            Self::UpToDate => "up_to_date",
            Self::UpdateAvailable => "update_available",
        }
    }
}

fn availability(local: Option<&str>, remote: &str) -> Availability {
    match local {
        None => Availability::NotInstalled,
        Some(local) if local == remote => Availability::UpToDate,
        Some(_) => Availability::UpdateAvailable,
    }
}

#[derive(Serialize)]
struct CheckReport<'a> {
    status: &'a str,
    local_version: Option<&'a str>,
    remote_version: &'a str,
    archive_url: &'a str,
    size_bytes: u64,
    sha256: &'a str,
}

#[derive(Serialize)]
struct UpToDateReport<'a> {
    status: &'a str,
    version: &'a str,
    index_dir: &'a str,
}

#[derive(Serialize)]
struct SyncedReport<'a> {
    status: &'a str,
    version: &'a str,
    index_dir: &'a str,
    size_bytes: u64,
}

fn write_json(out: &mut impl Write, value: &impl Serialize) -> Result<()> {
    serde_json::to_writer(&mut *out, value)?;
    writeln!(out)?;
    Ok(())
}

fn write_check_human(
    out: &mut impl Write,
    availability: Availability,
    local: Option<&str>,
    manifest: &Manifest,
) -> Result<()> {
    match availability {
        Availability::NotInstalled => {
            writeln!(out, "clec pack {} is not installed", manifest.pack_version)?;
            writeln!(out, "  run clec sync to install it")?;
        }
        Availability::UpToDate => {
            writeln!(out, "clec pack {} is up to date", manifest.pack_version)?;
        }
        Availability::UpdateAvailable => {
            writeln!(
                out,
                "Update available: {} -> {}",
                local.unwrap_or("not installed"),
                manifest.pack_version
            )?;
            writeln!(
                out,
                "  archive  {} ({})",
                manifest.archive_url,
                format_size(manifest.size_bytes)
            )?;
            writeln!(out, "  sha256   {}", manifest.sha256)?;
            writeln!(out, "  run clec sync to update")?;
        }
    }
    Ok(())
}

fn http_agent(body_timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(CONNECT_TIMEOUT))
        .timeout_recv_body(Some(body_timeout))
        .build()
        .into()
}

fn fetch_manifest(agent: &ureq::Agent, url: &str) -> Result<Manifest> {
    let mut response = agent
        .get(url)
        .call()
        .with_context(|| format!("fetching manifest from {url}"))?;
    let status = response.status().as_u16();
    ensure!(status == 200, "manifest {url} returned HTTP {status}");
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_MANIFEST_BYTES)
        .read_to_vec()
        .with_context(|| format!("reading manifest from {url}"))?;
    let manifest: Manifest =
        serde_json::from_slice(&body).with_context(|| format!("invalid manifest at {url}"))?;
    ensure!(
        manifest.schema_version == 2,
        "unsupported manifest schema version {} (expected 2)",
        manifest.schema_version
    );
    ensure!(
        is_sha256(&manifest.sha256),
        "manifest sha256 must be 64 lowercase hexadecimal characters"
    );
    ensure!(
        !manifest.pack_version.trim().is_empty(),
        "manifest pack_version is empty"
    );
    ensure!(
        !manifest.archive_url.trim().is_empty(),
        "manifest archive_url is empty"
    );
    Ok(manifest)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn local_version(index_dir: &Path) -> Option<String> {
    Metadata::load(&index_dir.join("meta.json"))
        .ok()
        .and_then(|metadata| metadata.pack_version)
}

fn install(manifest: &Manifest, index_dir: &Path) -> Result<()> {
    let parent = parent_dir(index_dir);
    fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let staging = tempfile::Builder::new()
        .prefix(".clec-sync-")
        .tempdir_in(parent)
        .with_context(|| format!("creating staging directory in {}", parent.display()))?;
    let partial = staging.path().join("archive.tar.zst.partial");
    download_archive(manifest, &partial)?;
    let unpacked = staging.path().join("unpacked");
    fs::create_dir(&unpacked)?;
    unpack(&partial, &unpacked)?;
    let root = normalized_root(&unpacked)?;
    Snapshot::open(&root).context("downloaded archive does not contain a valid clec index")?;
    let mut metadata = Metadata::load(&root.join("meta.json"))
        .context("downloaded archive has invalid corpus metadata")?;
    if metadata.pack_version.as_deref() != Some(manifest.pack_version.as_str()) {
        metadata.pack_version = Some(manifest.pack_version.clone());
        let path = root.join("meta.json");
        let mut file =
            File::create(&path).with_context(|| format!("writing {}", path.display()))?;
        serde_json::to_writer_pretty(&mut file, &metadata)
            .with_context(|| format!("writing {}", path.display()))?;
        file.sync_all()
            .with_context(|| format!("writing {}", path.display()))?;
    }
    swap(&root, index_dir, staging.path())
}

fn download_archive(manifest: &Manifest, partial: &Path) -> Result<()> {
    let agent = http_agent(DOWNLOAD_TIMEOUT);
    let mut sources: Vec<&str> = Vec::new();
    for url in std::iter::once(manifest.archive_url.as_str())
        .chain(manifest.mirrors.iter().map(String::as_str))
    {
        let url = url.trim();
        if !url.is_empty() && !sources.contains(&url) {
            sources.push(url);
        }
    }
    ensure!(!sources.is_empty(), "manifest contains no download URLs");

    let source_count = sources.len();
    let mut failures = Vec::new();
    for source in sources {
        let mut attempts = 0;
        loop {
            let before = file_size(partial);
            match download_once(&agent, source, partial) {
                Ok(()) => {
                    let actual = sha256_file(partial).ok();
                    if actual.as_deref() == Some(manifest.sha256.as_str()) {
                        return Ok(());
                    }
                    let _ = fs::remove_file(partial);
                    failures.push(match actual {
                        Some(actual) => {
                            format!("{source}: checksum mismatch (got {actual})")
                        }
                        None => format!("{source}: could not read downloaded archive"),
                    });
                    break;
                }
                Err(FetchError::Status(416)) => {
                    if checksum_matches(partial, &manifest.sha256) {
                        return Ok(());
                    }
                    if before > 0 && attempts == 0 {
                        let _ = fs::remove_file(partial);
                        attempts += 1;
                        continue;
                    }
                    failures.push(format!("{source}: HTTP 416"));
                    break;
                }
                Err(FetchError::Transport(error)) => {
                    let after = file_size(partial);
                    if after > before && attempts < MAX_DOWNLOAD_ATTEMPTS {
                        attempts += 1;
                        continue;
                    }
                    failures.push(format!("{source}: {error:#}"));
                    break;
                }
                Err(FetchError::Status(status)) => {
                    failures.push(format!("{source}: HTTP {status}"));
                    break;
                }
            }
        }
    }
    bail!(
        "failed to download clec pack {} (tried {source_count} source(s)): {}",
        manifest.pack_version,
        failures.join("; ")
    )
}

enum FetchError {
    Status(u16),
    Transport(anyhow::Error),
}

impl FetchError {
    fn transport(error: impl Into<anyhow::Error>) -> Self {
        Self::Transport(error.into())
    }
}

fn download_once(
    agent: &ureq::Agent,
    url: &str,
    partial: &Path,
) -> std::result::Result<(), FetchError> {
    let offset = file_size(partial);
    let mut request = agent.get(url);
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let mut response = request
        .call()
        .map_err(|error| FetchError::Transport(error.into()))?;
    let append = match response.status().as_u16() {
        200 => false,
        206 => offset > 0,
        416 => return Err(FetchError::Status(416)),
        status => return Err(FetchError::Status(status)),
    };
    let expected = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let encoded = response.headers().contains_key("content-encoding");
    let mut file = if append {
        File::options()
            .append(true)
            .open(partial)
            .map_err(FetchError::transport)?
    } else {
        File::create(partial).map_err(FetchError::transport)?
    };
    let mut reader = response.body_mut().as_reader();
    let copied = io::copy(&mut reader, &mut file).map_err(FetchError::transport)?;
    file.flush().map_err(FetchError::transport)?;
    file.sync_all().map_err(FetchError::transport)?;
    if let (false, Some(expected)) = (encoded, expected)
        && copied != expected
    {
        return Err(FetchError::Transport(anyhow::anyhow!(
            "incomplete body: received {copied} of {expected} bytes"
        )));
    }
    Ok(())
}

fn unpack(archive_path: &Path, destination: &Path) -> Result<()> {
    let file =
        File::open(archive_path).with_context(|| format!("opening {}", archive_path.display()))?;
    let decoder = zstd::Decoder::new(BufReader::new(file)).context("decompressing archive")?;
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().context("reading archive entries")? {
        let mut entry = entry.context("reading archive entry")?;
        let entry_type = entry.header().entry_type();
        let path = entry
            .path()
            .context("reading archive entry path")?
            .into_owned();
        validate_entry_path(&path)?;
        let target = destination.join(&path);
        if entry_type.is_dir() {
            fs::create_dir_all(&target)
                .with_context(|| format!("creating {}", target.display()))?;
        } else if entry_type.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
            let mut output =
                File::create(&target).with_context(|| format!("writing {}", target.display()))?;
            io::copy(&mut entry, &mut output)
                .with_context(|| format!("writing {}", target.display()))?;
        } else {
            bail!(
                "archive contains unsupported entry type at {}",
                path.display()
            );
        }
    }
    Ok(())
}

fn validate_entry_path(path: &Path) -> Result<()> {
    ensure!(
        !path.as_os_str().is_empty(),
        "archive contains an empty path"
    );
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("archive contains unsafe path {}", path.display());
            }
        }
    }
    Ok(())
}

fn normalized_root(unpacked: &Path) -> Result<PathBuf> {
    if unpacked.join("meta.json").is_file() && unpacked.join("index").is_dir() {
        return Ok(unpacked.to_path_buf());
    }
    let nested = unpacked.join("index");
    if nested.join("meta.json").is_file() && nested.join("index").is_dir() {
        return Ok(nested);
    }
    bail!("archive does not contain a clec index (expected meta.json and index/)")
}

fn swap(new: &Path, index_dir: &Path, staging: &Path) -> Result<()> {
    let backup = staging.join("previous");
    let existed = match fs::symlink_metadata(index_dir) {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(error).with_context(|| {
                format!("inspecting {} before replacing it", index_dir.display())
            });
        }
    };
    if existed {
        fs::rename(index_dir, &backup)
            .with_context(|| format!("moving existing index {} aside", index_dir.display()))?;
    }
    if let Err(error) = fs::rename(new, index_dir) {
        if existed {
            let _ = fs::rename(&backup, index_dir);
        }
        return Err(error).with_context(|| format!("installing index at {}", index_dir.display()));
    }
    if existed {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn parent_dir(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn checksum_matches(path: &Path, expected: &str) -> bool {
    sha256_file(path).is_ok_and(|actual| actual == expected)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        BufReader::new(File::open(path).with_context(|| format!("opening {}", path.display()))?);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
