use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

use rusqlite::{Connection, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::{
    Attribution, ByteSpan, CORPUS_FORMAT, ClecError, DateYmd, ErrorCode, PassageId, ReleaseHash,
    SCHEMA_VERSION, SEGMENTATION_REVISION, SourceId, SourceRole, WorkId, sha256_hex,
};
use crate::ingest::{extract_source, is_subtitle_path, is_supported_text_path, segment_source};
use crate::lexical::index_tokens_string;
use crate::store::{CorpusCounts, CorpusStore, DiagnosticsSummary, SCHEMA_SQL};

pub(crate) const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntakeWork {
    pub key: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntakeSource {
    pub work: String,
    pub path: String,
    pub title: String,
    pub role: String,
    pub attribution: String,
    pub quality: String,
    pub status: String,
    pub date: Option<String>,
    pub date_basis: Option<String>,
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntakeDocument {
    pub schema_version: u32,
    pub works: Vec<IntakeWork>,
    pub sources: Vec<IntakeSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub corpus_format: String,
    pub segmentation_revision: String,
    pub artifact: String,
    pub bytes: u64,
    pub sha256: ReleaseHash,
    pub compressed_bytes: u64,
    pub compressed_sha256: String,
    pub counts: CorpusCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncData {
    pub release: ReleaseHash,
    pub corpus_format: String,
    pub manifest_path: String,
    pub counts: CorpusCounts,
    pub reused: bool,
    pub storage_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusData {
    pub ready: bool,
    pub offline: bool,
    pub data_dir: String,
    pub corpus_format: Option<String>,
    pub active_release: Option<ReleaseHash>,
    pub manifest_path: Option<String>,
    pub counts: Option<CorpusCounts>,
    pub diagnostics: Option<DiagnosticsSummary>,
    pub storage_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveState {
    release: ReleaseHash,
    manifest_path: String,
}

pub fn publish_release(
    workspace: &Path,
    intake_path: &Path,
    output_dir: &Path,
) -> Result<ReleaseManifest, ClecError> {
    let canonical_workspace = fs::canonicalize(workspace).map_err(|e| {
        ClecError::new(
            ErrorCode::IoError,
            format!("Cannot resolve workspace {}: {e}", workspace.display()),
        )
    })?;

    if output_dir.exists() {
        return Err(ClecError::new(
            ErrorCode::OutputExists,
            format!("Output directory {} already exists.", output_dir.display()),
        ));
    }

    let intake_raw = fs::read_to_string(intake_path).map_err(|e| {
        ClecError::new(
            ErrorCode::InvalidManifest,
            format!("Cannot read intake {}: {e}", intake_path.display()),
        )
    })?;
    let intake: IntakeDocument = serde_json::from_str(&intake_raw).map_err(|e| {
        ClecError::new(
            ErrorCode::InvalidManifest,
            format!("Invalid intake JSON: {e}"),
        )
    })?;
    if intake.schema_version != SCHEMA_VERSION {
        return Err(ClecError::new(
            ErrorCode::InvalidManifest,
            format!(
                "Unsupported intake schemaVersion {}; expected {SCHEMA_VERSION}.",
                intake.schema_version
            ),
        ));
    }
    if intake.works.is_empty() || intake.sources.is_empty() {
        return Err(ClecError::new(
            ErrorCode::EmptyCorpus,
            "Intake must declare at least one work and one source.",
        ));
    }

    let mut work_map: HashMap<String, (WorkId, String)> = HashMap::new();
    for w in &intake.works {
        let wid = WorkId::from_work_key(&w.key)?;
        if w.title.trim().is_empty() || w.title.contains('\0') {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                format!("Work '{}' has empty or invalid title.", w.key),
            ));
        }
        if work_map
            .insert(w.key.clone(), (wid, w.title.clone()))
            .is_some()
        {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                format!("Duplicate work key '{}'.", w.key),
            ));
        }
    }

    let parent = output_dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(map_io)?;
    let staging = parent.join(format!(
        ".{}.building.{}",
        output_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("release"),
        std::process::id()
    ));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging).map_err(map_io)?;

    let build_res = build_in_staging(&canonical_workspace, &intake, &work_map, &staging);
    match build_res {
        Ok(manifest) => {
            if let Err(e) = fs::rename(&staging, output_dir) {
                let _ = fs::remove_dir_all(&staging);
                return Err(map_io(e));
            }
            Ok(manifest)
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

fn validate_relative_path(raw: &str) -> Result<PathBuf, ClecError> {
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

fn build_in_staging(
    canonical_workspace: &Path,
    intake: &IntakeDocument,
    work_map: &HashMap<String, (WorkId, String)>,
    staging: &Path,
) -> Result<ReleaseManifest, ClecError> {
    let sqlite_path = staging.join("corpus.sqlite");
    let zst_path = staging.join("corpus.sqlite.zst");

    let mut conn = Connection::open(&sqlite_path)
        .map_err(|e| ClecError::new(ErrorCode::IoError, format!("Cannot create SQLite DB: {e}")))?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| {
        ClecError::new(
            ErrorCode::InternalError,
            format!("Schema creation failed: {e}"),
        )
    })?;
    conn.execute(
        "INSERT INTO metadata VALUES('corpus_format', ?),('segmentation_revision', ?)",
        [CORPUS_FORMAT, SEGMENTATION_REVISION],
    )
    .map_err(|e| {
        ClecError::new(
            ErrorCode::InternalError,
            format!("Metadata insert failed: {e}"),
        )
    })?;

    let mut seen_work_paths: HashSet<(String, String)> = HashSet::new();
    let mut inserted_works: HashSet<String> = HashSet::new();
    let mut inserted_blobs: HashSet<String> = HashSet::new();
    let mut counts = CorpusCounts {
        works: 0,
        sources: 0,
        blobs: 0,
        passages: 0,
        cues: 0,
        inventory: 0,
    };

    let mut sorted_sources: Vec<&IntakeSource> = intake.sources.iter().collect();
    sorted_sources.sort_by(|a, b| a.work.cmp(&b.work).then_with(|| a.path.cmp(&b.path)));

    let tx = conn
        .transaction()
        .map_err(|e| ClecError::new(ErrorCode::InternalError, format!("TX start failed: {e}")))?;

    for src in sorted_sources {
        let Some((work_id, work_title)) = work_map.get(&src.work) else {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                format!(
                    "Source '{}' references undeclared work '{}'.",
                    src.path, src.work
                ),
            ));
        };
        let rel = validate_relative_path(&src.path)?;
        if !seen_work_paths.insert((src.work.clone(), src.path.clone())) {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                format!("Duplicate source '{}' under work '{}'.", src.path, src.work),
            ));
        }
        let role = SourceRole::parse(&src.role)?;
        let attribution = Attribution::parse(&src.attribution)?;
        if src.title.trim().is_empty() || src.quality.trim().is_empty() {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                format!("Source '{}' has empty title or quality.", src.path),
            ));
        }
        let date = match &src.date {
            Some(d) => {
                if src
                    .date_basis
                    .as_deref()
                    .is_none_or(|b| b.trim().is_empty())
                {
                    return Err(ClecError::new(
                        ErrorCode::InvalidManifest,
                        format!("Source '{}' with date requires dateBasis.", src.path),
                    ));
                }
                Some(DateYmd::parse(d)?)
            }
            None => None,
        };

        let mut record_inventory =
            |status: &str, reason: &str, chash: Option<&str>| -> Result<(), ClecError> {
                tx.execute(
                    "INSERT INTO inventory VALUES(?,?,?,?,?)",
                    params![src.path, src.work, status, reason, chash],
                )
                .map_err(|e| {
                    ClecError::new(
                        ErrorCode::InternalError,
                        format!("Inventory insert failed: {e}"),
                    )
                })?;
                counts.inventory += 1;
                Ok(())
            };

        if src.status != "ready" {
            if !matches!(
                src.status.as_str(),
                "quarantined" | "unsupported" | "metadata_only"
            ) {
                return Err(ClecError::new(
                    ErrorCode::InvalidManifest,
                    format!("Unknown intake status '{}' for '{}'.", src.status, src.path),
                ));
            }
            record_inventory(&src.status, "Excluded by intake status.", None)?;
            continue;
        }

        if !is_supported_text_path(&src.path) {
            record_inventory("unsupported", "Unsupported file extension.", None)?;
            continue;
        }

        let target = fs::canonicalize(canonical_workspace.join(&rel)).map_err(|e| {
            ClecError::new(
                ErrorCode::InvalidManifest,
                format!("Source '{}' not readable: {e}", src.path),
            )
        })?;
        if !target.starts_with(canonical_workspace) {
            return Err(ClecError::new(
                ErrorCode::UnsafePath,
                format!("Source '{}' resolves outside workspace.", src.path),
            ));
        }
        let meta = fs::metadata(&target).map_err(map_io)?;
        if meta.len() > MAX_SOURCE_BYTES {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                format!("Source '{}' exceeds 100 MiB size limit.", src.path),
            ));
        }
        let raw_bytes = fs::read(&target).map_err(map_io)?;
        let content_hash = sha256_hex(&raw_bytes);

        let is_sub = is_subtitle_path(&src.path);
        let extraction = match extract_source(&raw_bytes, is_sub) {
            Ok(ext) => ext,
            Err(_) => {
                record_inventory(
                    "unsupported",
                    "Invalid UTF-8 encoding.",
                    Some(&content_hash),
                )?;
                continue;
            }
        };

        if extraction.text.trim().is_empty() || extraction.text.contains('\0') {
            let st = if extraction.text.contains('\0') {
                "quarantined"
            } else {
                "empty"
            };
            record_inventory(st, "Empty text or NUL bytes.", Some(&content_hash))?;
            continue;
        }

        if is_sub && extraction.cues.is_empty() {
            record_inventory(
                "unsupported",
                "No usable subtitle cues.",
                Some(&content_hash),
            )?;
            continue;
        }

        let drafts = segment_source(&extraction, role)?;

        if inserted_works.insert(work_id.as_str().to_owned()) {
            tx.execute(
                "INSERT INTO works VALUES(?,?,?)",
                params![work_id.as_str(), src.work, work_title],
            )
            .map_err(|e| {
                ClecError::new(ErrorCode::InternalError, format!("Work insert failed: {e}"))
            })?;
            counts.works += 1;
        }

        if inserted_blobs.insert(content_hash.clone()) {
            tx.execute(
                "INSERT INTO blobs VALUES(?,?,?)",
                params![content_hash, raw_bytes, raw_bytes.len() as i64],
            )
            .map_err(|e| {
                ClecError::new(ErrorCode::InternalError, format!("Blob insert failed: {e}"))
            })?;
            counts.blobs += 1;
        }

        let source_id = SourceId::derive(
            work_id,
            &src.path,
            role,
            attribution,
            &content_hash,
            date.as_ref(),
            src.date_basis.as_deref(),
        );
        tx.execute(
            "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                source_id.as_str(),
                work_id.as_str(),
                src.path,
                src.title,
                role.as_str(),
                attribution.as_str(),
                src.quality,
                date.as_ref().map(DateYmd::as_str),
                src.date_basis.as_deref(),
                src.origin.as_deref(),
                content_hash
            ],
        )
        .map_err(|e| {
            ClecError::new(
                ErrorCode::InternalError,
                format!("Source insert failed: {e}"),
            )
        })?;
        counts.sources += 1;

        for (ord, diag) in extraction.diagnostics.iter().enumerate() {
            tx.execute(
                "INSERT INTO source_diagnostics VALUES(?,?,?)",
                params![source_id.as_str(), ord as i64, diag],
            )
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InternalError,
                    format!("Diagnostic insert failed: {e}"),
                )
            })?;
        }

        for cue in &extraction.cues {
            tx.execute(
                "INSERT INTO cues VALUES(?,?,?,?,?,?,?,?,?)",
                params![
                    source_id.as_str(),
                    cue.ordinal as i64,
                    cue.original_identifier.as_deref(),
                    cue.raw_start_byte as i64,
                    cue.raw_end_byte as i64,
                    cue.text_start_byte as i64,
                    cue.text_end_byte as i64,
                    cue.start_ms as i64,
                    cue.end_ms as i64
                ],
            )
            .map_err(|e| {
                ClecError::new(ErrorCode::InternalError, format!("Cue insert failed: {e}"))
            })?;
            counts.cues += 1;
        }

        let derived_ids: Vec<PassageId> = drafts
            .iter()
            .map(|d| PassageId::derive(&source_id, d.ordinal, &d.spans))
            .collect();

        let title_toks = index_tokens_string(&src.title);
        for (idx, draft) in drafts.iter().enumerate() {
            let pid = &derived_ids[idx];
            let continued_from = if draft.is_continuation && idx > 0 {
                Some(derived_ids[idx - 1].as_str())
            } else {
                None
            };
            let continued_to = if idx + 1 < drafts.len() && drafts[idx + 1].is_continuation {
                Some(derived_ids[idx + 1].as_str())
            } else {
                None
            };

            tx.execute(
                "INSERT INTO passages VALUES(?,?,?,?,?,?,?,?,?)",
                params![
                    pid.as_str(),
                    source_id.as_str(),
                    work_id.as_str(),
                    draft.ordinal as i64,
                    draft.boundary.as_str(),
                    i64::from(draft.is_continuation),
                    continued_from,
                    continued_to,
                    draft.text
                ],
            )
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InternalError,
                    format!("Passage insert failed: {e}"),
                )
            })?;
            let rowid = tx.last_insert_rowid();

            for (span_ord, span) in draft.spans.iter().enumerate() {
                let span_val: &ByteSpan = span;
                tx.execute(
                    "INSERT INTO passage_spans VALUES(?,?,?,?,?)",
                    params![
                        pid.as_str(),
                        span_ord as i64,
                        span_val.start_byte() as i64,
                        span_val.end_byte() as i64,
                        span_val.cue_ordinal().map(|v| v as i64)
                    ],
                )
                .map_err(|e| {
                    ClecError::new(ErrorCode::InternalError, format!("Span insert failed: {e}"))
                })?;
            }

            tx.execute(
                "INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(?,?,?)",
                params![rowid, title_toks, index_tokens_string(&draft.text)],
            )
            .map_err(|e| {
                ClecError::new(ErrorCode::InternalError, format!("FTS insert failed: {e}"))
            })?;
            counts.passages += 1;
        }

        record_inventory("indexed", "Admitted and indexed.", Some(&content_hash))?;
    }

    if counts.sources == 0 {
        return Err(ClecError::new(
            ErrorCode::EmptyCorpus,
            "No usable ready sources were admitted.",
        ));
    }

    tx.commit()
        .map_err(|e| ClecError::new(ErrorCode::InternalError, format!("Commit failed: {e}")))?;
    conn.execute_batch("INSERT INTO search(search) VALUES('optimize');")
        .map_err(|e| {
            ClecError::new(
                ErrorCode::InternalError,
                format!("FTS optimize failed: {e}"),
            )
        })?;
    drop(conn);

    let (bytes, sha256_str) = file_size_and_sha256(&sqlite_path)?;
    let release = ReleaseHash::parse(&sha256_str)?;

    CorpusStore::validate_staging_db(&sqlite_path, release.clone(), &counts)?;
    let (post_bytes, post_sha) = file_size_and_sha256(&sqlite_path)?;
    if post_bytes != bytes || post_sha != sha256_str {
        return Err(ClecError::new(
            ErrorCode::InternalError,
            "Staging database bytes changed during validation.",
        ));
    }

    {
        let src_file = File::open(&sqlite_path).map_err(map_io)?;
        let dst_file = File::create(&zst_path).map_err(map_io)?;
        zstd::stream::copy_encode(BufReader::new(src_file), dst_file, 3).map_err(|e| {
            ClecError::new(ErrorCode::IoError, format!("Zstd compression failed: {e}"))
        })?;
    }
    fs::remove_file(&sqlite_path).map_err(map_io)?;

    let (compressed_bytes, compressed_sha256) = file_size_and_sha256(&zst_path)?;
    if bytes > MAX_ARTIFACT_BYTES || compressed_bytes > MAX_ARTIFACT_BYTES {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Artifact exceeds 2 GiB cap.",
        ));
    }

    let manifest = ReleaseManifest {
        schema_version: SCHEMA_VERSION,
        corpus_format: CORPUS_FORMAT.to_owned(),
        segmentation_revision: SEGMENTATION_REVISION.to_owned(),
        artifact: "corpus.sqlite.zst".to_owned(),
        bytes,
        sha256: release,
        compressed_bytes,
        compressed_sha256,
        counts,
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| {
        ClecError::new(
            ErrorCode::InternalError,
            format!("Manifest serialize failed: {e}"),
        )
    })?;
    let mut mf = File::create(staging.join("manifest.json")).map_err(map_io)?;
    mf.write_all(&manifest_bytes).map_err(map_io)?;
    mf.write_all(b"\n").map_err(map_io)?;
    mf.sync_all().map_err(map_io)?;

    Ok(manifest)
}

fn file_size_and_sha256(path: &Path) -> Result<(u64, String), ClecError> {
    let mut file = File::open(path).map_err(map_io)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65_536];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(map_io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, crate::domain::hex_encode(&hasher.finalize())))
}

pub(crate) fn open_current_store(
    data_dir: &Path,
    release_pin: Option<&ReleaseHash>,
) -> Result<CorpusStore, ClecError> {
    let Some(state) = read_active_state(data_dir)? else {
        return Err(ClecError::new(
            ErrorCode::NoData,
            "No active corpus snapshot in --data-dir. Run `clec sync --manifest PATH` first.",
        ));
    };
    if let Some(pin) = release_pin
        && pin != &state.release
    {
        return Err(ClecError::new(
            ErrorCode::VersionUnavailable,
            "Requested release is no longer active.",
        ));
    }
    let db_path = data_dir.join(format!("{}.sqlite", state.release.as_str()));
    if !db_path.is_file() {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Active corpus SQLite file is missing.",
        ));
    }
    CorpusStore::open_readonly(&db_path, state.release)
}

pub(crate) fn data_dir_status(data_dir: &Path) -> Result<StatusData, ClecError> {
    let state = read_active_state(data_dir)?;
    let storage_bytes = compute_managed_bytes(data_dir)?;
    let data_dir_str = data_dir.display().to_string();

    match state {
        Some(active) => {
            let db_path = data_dir.join(format!("{}.sqlite", active.release.as_str()));
            if !db_path.is_file() {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Active corpus SQLite file is missing.",
                ));
            }
            let store = CorpusStore::open_readonly(&db_path, active.release.clone())?;
            let counts = store.counts()?;
            let diagnostics = store.diagnostics_summary()?;
            Ok(StatusData {
                ready: true,
                offline: true,
                data_dir: data_dir_str,
                corpus_format: Some(CORPUS_FORMAT.to_owned()),
                active_release: Some(active.release),
                manifest_path: Some(active.manifest_path),
                counts: Some(counts),
                diagnostics: Some(diagnostics),
                storage_bytes,
            })
        }
        None => Ok(StatusData {
            ready: false,
            offline: true,
            data_dir: data_dir_str,
            corpus_format: None,
            active_release: None,
            manifest_path: None,
            counts: None,
            diagnostics: None,
            storage_bytes,
        }),
    }
}

#[cfg(test)]
pub(crate) fn sync_local(
    data_dir: &Path,
    manifest_arg: Option<&str>,
) -> Result<SyncData, ClecError> {
    sync_local_with_prepare(data_dir, manifest_arg, |data| Ok(data.clone()))
}

pub(crate) fn sync_local_with_prepare<T, F>(
    data_dir: &Path,
    manifest_arg: Option<&str>,
    prepare_output: F,
) -> Result<T, ClecError>
where
    F: FnOnce(&SyncData) -> Result<T, ClecError>,
{
    if data_dir.exists() && !data_dir.is_dir() {
        return Err(ClecError::new(
            ErrorCode::InvalidDataDir,
            "--data-dir must point to a directory.",
        ));
    }
    fs::create_dir_all(data_dir).map_err(|e| {
        ClecError::new(
            ErrorCode::InvalidDataDir,
            format!("Cannot create --data-dir {}: {e}", data_dir.display()),
        )
    })?;

    let lock_path = data_dir.join(".sync.lock");
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(map_io)?;
    lock_file.try_lock().map_err(|_| {
        ClecError::new(
            ErrorCode::SyncLocked,
            "Another sync process currently holds the lock on --data-dir.",
        )
    })?;

    let result = sync_locked(data_dir, manifest_arg, prepare_output);
    let _ = lock_file.unlock();
    result
}

fn sync_locked<T, F>(
    data_dir: &Path,
    manifest_arg: Option<&str>,
    prepare_output: F,
) -> Result<T, ClecError>
where
    F: FnOnce(&SyncData) -> Result<T, ClecError>,
{
    let prev_state_res = read_active_state(data_dir);
    let manifest_str = match manifest_arg {
        Some(raw) => {
            if raw.starts_with("http://") || raw.starts_with("https://") {
                return Err(ClecError::new(
                    ErrorCode::UnsupportedFeature,
                    "Remote HTTP sync is unsupported in Phase 1; pass a local manifest file path.",
                ));
            }
            raw.to_owned()
        }
        None => prev_state_res
            .as_ref()
            .map_err(|e| e.clone())?
            .as_ref()
            .map(|s| s.manifest_path.clone())
            .ok_or_else(|| {
                ClecError::new(
                    ErrorCode::NoData,
                    "No manifest path configured. Pass --manifest FILE.",
                )
            })?,
    };

    let manifest_path = fs::canonicalize(&manifest_str).map_err(|e| {
        ClecError::new(
            ErrorCode::IoError,
            format!("Cannot read manifest {}: {e}", manifest_str),
        )
    })?;
    let manifest_path_str = manifest_path.display().to_string();
    let manifest_raw = fs::read(&manifest_path).map_err(map_io)?;
    if manifest_raw.len() > 1024 * 1024 {
        return Err(ClecError::new(
            ErrorCode::InvalidManifest,
            "Manifest exceeds 1 MiB limit.",
        ));
    }

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
    if !artifact_path.is_file() {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            format!("Artifact {} is missing.", artifact_path.display()),
        ));
    }

    let (comp_bytes, comp_sha) = file_size_and_sha256(&artifact_path)?;
    if comp_bytes != manifest.compressed_bytes || comp_sha != manifest.compressed_sha256 {
        return Err(ClecError::new(
            ErrorCode::IntegrityMismatch,
            "Compressed artifact size or SHA-256 does not match manifest.",
        ));
    }

    let prev_state = prev_state_res.ok().flatten();
    let prev_release = prev_state.as_ref().map(|s| s.release.clone());

    if let Some(ref state) = prev_state
        && state.release == manifest.sha256
    {
        let existing_path = data_dir.join(format!("{}.sqlite", manifest.sha256.as_str()));
        if existing_path.is_file()
            && let Ok(existing) = CorpusStore::open_readonly(&existing_path, state.release.clone())
            && let Ok((existing_bytes, existing_sha)) = file_size_and_sha256(&existing_path)
            && existing_bytes == manifest.bytes
            && existing_sha == manifest.sha256.as_str()
            && existing.counts().ok().as_ref() == Some(&manifest.counts)
        {
            if state.manifest_path == manifest_path_str {
                let storage_bytes = compute_managed_bytes(data_dir)?;
                let sync_data = SyncData {
                    release: manifest.sha256,
                    corpus_format: manifest.corpus_format,
                    manifest_path: manifest_path_str,
                    counts: manifest.counts,
                    reused: true,
                    storage_bytes,
                };
                return prepare_output(&sync_data);
            }

            let (active_tmp, active_tmp_len) =
                write_active_state_tmp(data_dir, &manifest.sha256, &manifest_path_str)?;
            let commit_res = (|| -> Result<T, ClecError> {
                let storage_bytes = compute_projected_managed_bytes(
                    data_dir,
                    &existing_path,
                    existing_bytes,
                    active_tmp_len,
                )?;
                let sync_data = SyncData {
                    release: manifest.sha256.clone(),
                    corpus_format: manifest.corpus_format.clone(),
                    manifest_path: manifest_path_str.clone(),
                    counts: manifest.counts.clone(),
                    reused: true,
                    storage_bytes,
                };
                let prepared = prepare_output(&sync_data)?;
                fs::rename(&active_tmp, active_state_path(data_dir)).map_err(map_io)?;
                Ok(prepared)
            })();
            if commit_res.is_err() {
                let _ = fs::remove_file(&active_tmp);
            } else {
                sync_dir_best_effort(data_dir);
            }
            return commit_res;
        }
    }

    let staging_db = data_dir.join(".incoming.sqlite.tmp");
    let _ = fs::remove_file(&staging_db);
    let final_db = data_dir.join(format!("{}.sqlite", manifest.sha256.as_str()));
    let active_tmp_path = data_dir.join(".active.tmp");
    let _ = fs::remove_file(&active_tmp_path);
    let remove_final_on_err = prev_release.as_ref() != Some(&manifest.sha256);

    let install_res = (|| -> Result<T, ClecError> {
        let src_file = File::open(&artifact_path).map_err(map_io)?;
        let mut decoder = zstd::stream::Decoder::new(BufReader::new(src_file)).map_err(|e| {
            ClecError::new(
                ErrorCode::InvalidPackage,
                format!("Invalid zstd stream: {e}"),
            )
        })?;
        let mut dst_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging_db)
            .map_err(map_io)?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65_536];
        let mut total = 0u64;
        loop {
            let n = decoder.read(&mut buf).map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Zstd decompression failed: {e}"),
                )
            })?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > manifest.bytes {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "Decompressed artifact exceeds declared manifest bytes.",
                ));
            }
            hasher.update(&buf[..n]);
            dst_file.write_all(&buf[..n]).map_err(map_io)?;
        }
        dst_file.sync_all().map_err(map_io)?;
        drop(dst_file);

        let decomp_sha = crate::domain::hex_encode(&hasher.finalize());
        if total != manifest.bytes || decomp_sha != manifest.sha256.as_str() {
            return Err(ClecError::new(
                ErrorCode::IntegrityMismatch,
                "Decompressed SQLite size or SHA-256 does not match manifest.",
            ));
        }

        CorpusStore::validate_staging_db(&staging_db, manifest.sha256.clone(), &manifest.counts)?;

        fs::rename(&staging_db, &final_db).map_err(map_io)?;

        let (_, active_tmp_len) =
            write_active_state_tmp(data_dir, &manifest.sha256, &manifest_path_str)?;
        let storage_bytes =
            compute_projected_managed_bytes(data_dir, &final_db, total, active_tmp_len)?;
        let sync_data = SyncData {
            release: manifest.sha256.clone(),
            corpus_format: manifest.corpus_format.clone(),
            manifest_path: manifest_path_str.clone(),
            counts: manifest.counts.clone(),
            reused: false,
            storage_bytes,
        };
        let prepared = prepare_output(&sync_data)?;

        fs::rename(&active_tmp_path, active_state_path(data_dir)).map_err(map_io)?;
        Ok(prepared)
    })();

    if install_res.is_err() {
        let _ = fs::remove_file(&staging_db);
        let _ = fs::remove_file(&active_tmp_path);
        if remove_final_on_err {
            let _ = fs::remove_file(&final_db);
        }
        return install_res;
    }

    sync_dir_best_effort(data_dir);
    cleanup_old_releases(data_dir, manifest.sha256.as_str());
    install_res
}

fn validate_manifest_fields(m: &ReleaseManifest) -> Result<(), ClecError> {
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
    Ok(())
}

fn active_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("active.json")
}

fn write_active_state_tmp(
    data_dir: &Path,
    release: &ReleaseHash,
    manifest_path: &str,
) -> Result<(PathBuf, u64), ClecError> {
    let tmp = data_dir.join(".active.tmp");
    let _ = fs::remove_file(&tmp);
    let state = ActiveState {
        release: release.clone(),
        manifest_path: manifest_path.to_owned(),
    };
    let mut bytes = serde_json::to_vec_pretty(&state).map_err(|e| {
        ClecError::new(
            ErrorCode::InternalError,
            format!("Active state serialize failed: {e}"),
        )
    })?;
    bytes.push(b'\n');
    let mut f = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .map_err(map_io)?;
    f.write_all(&bytes).map_err(map_io)?;
    f.sync_all().map_err(map_io)?;
    Ok((tmp, bytes.len() as u64))
}

fn read_active_state(data_dir: &Path) -> Result<Option<ActiveState>, ClecError> {
    let path = active_state_path(data_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(map_io(e)),
    };
    let state: ActiveState = serde_json::from_str(&raw).map_err(|e| {
        ClecError::new(
            ErrorCode::InvalidPackage,
            format!("Invalid active.json in --data-dir: {e}"),
        )
    })?;
    Ok(Some(state))
}

fn sync_dir_best_effort(dir: &Path) {
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

fn cleanup_old_releases(data_dir: &Path, active_sha: &str) {
    let active_name = format!("{active_sha}.sqlite");
    if let Ok(entries) = fs::read_dir(data_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if s.ends_with(".sqlite") && s.len() == 71 && s != active_name {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn compute_managed_bytes(data_dir: &Path) -> Result<u64, ClecError> {
    if !data_dir.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(data_dir).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        if let Ok(meta) = entry.metadata()
            && meta.is_file()
        {
            total += meta.len();
        }
    }
    Ok(total)
}

fn compute_projected_managed_bytes(
    data_dir: &Path,
    final_db: &Path,
    final_db_len: u64,
    active_state_len: u64,
) -> Result<u64, ClecError> {
    let final_db_name = final_db
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut total = final_db_len + active_state_len;
    for entry in fs::read_dir(data_dir).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let name = entry.file_name();
        let s = name.to_string_lossy();
        let is_superseded_db = s.ends_with(".sqlite") && s.len() == 71 && s != final_db_name;
        if s == "active.json"
            || s == ".active.tmp"
            || s == ".incoming.sqlite.tmp"
            || s == final_db_name
            || is_superseded_db
        {
            continue;
        }
        if let Ok(meta) = entry.metadata()
            && meta.is_file()
        {
            total += meta.len();
        }
    }
    Ok(total)
}

fn map_io(err: std::io::Error) -> ClecError {
    ClecError::new(ErrorCode::IoError, format!("Filesystem error: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_sync_relocate_idempotent_and_rollback_work_end_to_end() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), "0050與QQQ投資討論\n每年4%提領原則\n").unwrap();
        fs::write(
            ws.join("b.srt"),
            "1\n00:00:00,000 --> 00:00:02,000\n退休現金😀\n",
        )
        .unwrap();

        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            r#"{
              "schemaVersion": 1,
              "works": [
                { "key": "ep1", "title": "Episode 1" },
                { "key": "ep2", "title": "Episode 2" }
              ],
              "sources": [
                {
                  "work": "ep1",
                  "path": "a.txt",
                  "title": "Episode 1 Text",
                  "role": "document",
                  "attribution": "publisher_verified",
                  "quality": "fixture",
                  "status": "ready",
                  "date": "2025-05-01",
                  "dateBasis": "fixture"
                },
                {
                  "work": "ep2",
                  "path": "b.srt",
                  "title": "Episode 2 Subtitles",
                  "role": "transcript",
                  "attribution": "machine_unverified",
                  "quality": "fixture",
                  "status": "ready"
                }
              ]
            }"#,
        )
        .unwrap();

        let release1 = tmp.path().join("release1");
        let manifest1 = publish_release(&ws, &intake, &release1).unwrap();
        assert_eq!(manifest1.counts.works, 2);
        assert_eq!(manifest1.counts.sources, 2);

        let data_dir = tmp.path().join("data");
        let synced1 = sync_local(
            &data_dir,
            Some(&release1.join("manifest.json").display().to_string()),
        )
        .unwrap();
        assert!(!synced1.reused);
        assert_eq!(synced1.release, manifest1.sha256);

        let synced2 = sync_local(
            &data_dir,
            Some(&release1.join("manifest.json").display().to_string()),
        )
        .unwrap();
        assert!(synced2.reused);

        let bad_release = tmp.path().join("bad-release");
        fs::create_dir_all(&bad_release).unwrap();
        fs::copy(
            release1.join("manifest.json"),
            bad_release.join("manifest.json"),
        )
        .unwrap();
        let mut bad_zst = fs::read(release1.join("corpus.sqlite.zst")).unwrap();
        bad_zst[10] ^= 0xff;
        fs::write(bad_release.join("corpus.sqlite.zst"), &bad_zst).unwrap();
        let err = sync_local(
            &data_dir,
            Some(&bad_release.join("manifest.json").display().to_string()),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::IntegrityMismatch);

        fs::remove_dir_all(&release1).unwrap();
        let relocated = tmp.path().join("relocated-data");
        fs::rename(&data_dir, &relocated).unwrap();
        let st = data_dir_status(&relocated).unwrap();
        assert!(st.ready);
        assert_eq!(st.active_release.as_ref(), Some(&manifest1.sha256));
    }

    #[test]
    fn sync_preserves_prior_release_on_prepare_failure_obstruction_and_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let ws_a = tmp.path().join("ws_a");
        let ws_b = tmp.path().join("ws_b");
        fs::create_dir_all(&ws_a).unwrap();
        fs::create_dir_all(&ws_b).unwrap();
        fs::write(ws_a.join("a.txt"), "alpha release content").unwrap();
        fs::write(ws_b.join("b.txt"), "beta release content").unwrap();

        let intake_a = tmp.path().join("intake_a.json");
        let intake_b = tmp.path().join("intake_b.json");
        fs::write(
            &intake_a,
            r#"{"schemaVersion":1,"works":[{"key":"wa","title":"A"}],"sources":[{"work":"wa","path":"a.txt","title":"A","role":"document","attribution":"authored_fixture","quality":"fixture","status":"ready"}]}"#,
        )
        .unwrap();
        fs::write(
            &intake_b,
            r#"{"schemaVersion":1,"works":[{"key":"wb","title":"B"}],"sources":[{"work":"wb","path":"b.txt","title":"B","role":"document","attribution":"authored_fixture","quality":"fixture","status":"ready"}]}"#,
        )
        .unwrap();

        let rel_a = tmp.path().join("rel_a");
        let rel_b = tmp.path().join("rel_b");
        let m_a = publish_release(&ws_a, &intake_a, &rel_a).unwrap();
        let m_b = publish_release(&ws_b, &intake_b, &rel_b).unwrap();
        assert_ne!(m_a.sha256, m_b.sha256);

        let data_dir = tmp.path().join("data");
        let m_a_path = rel_a.join("manifest.json").display().to_string();
        let m_b_path = rel_b.join("manifest.json").display().to_string();

        let first = sync_local(&data_dir, Some(&m_a_path)).unwrap();
        assert_eq!(first.release, m_a.sha256);
        let st_initial = data_dir_status(&data_dir).unwrap();
        assert_eq!(first.storage_bytes, st_initial.storage_bytes);

        let budget_err = sync_local_with_prepare(&data_dir, Some(&m_b_path), |_| {
            Err::<(), ClecError>(ClecError::new(
                ErrorCode::OutputBudgetTooSmall,
                "simulated budget failure before commit",
            ))
        })
        .unwrap_err();
        assert_eq!(budget_err.code, ErrorCode::OutputBudgetTooSmall);
        assert!(data_dir.join(format!("{}.sqlite", m_a.sha256)).is_file());
        assert!(!data_dir.join(format!("{}.sqlite", m_b.sha256)).exists());
        let st_after_budget = data_dir_status(&data_dir).unwrap();
        assert_eq!(st_after_budget.active_release.as_ref(), Some(&m_a.sha256));

        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(data_dir.join(".sync.lock"))
            .unwrap();
        lock_file.lock().unwrap();
        let lock_err = sync_local(&data_dir, Some(&m_b_path)).unwrap_err();
        assert_eq!(lock_err.code, ErrorCode::SyncLocked);
        lock_file.unlock().unwrap();

        let obs_dir = tmp.path().join("obs_data");
        sync_local(&obs_dir, Some(&m_a_path)).unwrap();
        fs::remove_file(obs_dir.join("active.json")).unwrap();
        fs::create_dir(obs_dir.join("active.json")).unwrap();
        let obs_err = sync_local(&obs_dir, Some(&m_b_path)).unwrap_err();
        assert_eq!(obs_err.code, ErrorCode::IoError);
        assert!(obs_dir.join(format!("{}.sqlite", m_a.sha256)).is_file());
        assert!(!obs_dir.join(format!("{}.sqlite", m_b.sha256)).exists());
    }
}
