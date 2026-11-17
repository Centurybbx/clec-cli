use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::distribution::{
    MAX_ARTIFACT_BYTES, ManifestLocation, NetworkPolicy, TransferPolicy, acquire_artifact,
    cleanup_stale_staging, is_staging_temp_name, load_manifest, validate_relative_path,
    validate_remote_url_syntax,
};
use crate::domain::{
    Attribution, ByteSpan, CORPUS_FORMAT, CanonicalCandidate, ClecError, DICTIONARY_REVISION,
    DateYmd, EQUIVALENCE_REVISION, EquivalenceBasis, ErrorCode, NORMALIZATION_REVISION, PassageId,
    ProjectionKind, ReleaseHash, SCHEMA_VERSION, SEGMENTATION_REVISION, SourceId, SourceRole,
    TOKENIZATION_REVISION, WorkId, select_canonical_index, sha256_hex,
};
use crate::ingest::{
    compute_equivalence_projection, extract_source, is_subtitle_path, is_supported_text_path,
    segment_source,
};
use crate::lexical::index_tokens_string;
use crate::store::{CorpusCounts, CorpusStore, DiagnosticsSummary, SCHEMA_SQL};

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
    pub status_reason: Option<String>,
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
    pub tokenization_revision: String,
    pub normalization_revision: String,
    pub dictionary_revision: String,
    pub equivalence_revision: String,
    pub artifact: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_url: Option<String>,
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
pub(crate) struct SyncDryRunData {
    pub dry_run: bool,
    pub manifest_path: String,
    pub release: ReleaseHash,
    pub corpus_format: String,
    pub bytes: u64,
    pub compressed_bytes: u64,
    pub counts: CorpusCounts,
    pub is_active: bool,
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

pub const VALIDATOR_KIND: &str = "clec_core_validate_staging_db";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotValidationReceipt {
    pub schema_version: u32,
    pub validator_kind: String,
    pub package_version: String,
    pub corpus_format: String,
    pub segmentation_revision: String,
    pub tokenization_revision: String,
    pub normalization_revision: String,
    pub dictionary_revision: String,
    pub equivalence_revision: String,
    pub db_path: String,
    pub db_bytes: u64,
    pub db_sha256: ReleaseHash,
    pub valid: bool,
    pub counts: Option<CorpusCounts>,
    pub error_code: Option<ErrorCode>,
    pub error_message: Option<String>,
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
    publish_release_with_artifact_url(workspace, intake_path, output_dir, None)
}

pub fn publish_release_with_artifact_url(
    workspace: &Path,
    intake_path: &Path,
    output_dir: &Path,
    artifact_url: Option<&str>,
) -> Result<ReleaseManifest, ClecError> {
    let validated_artifact_url = match artifact_url {
        Some(raw) => {
            let trimmed = raw.trim();
            validate_remote_url_syntax(trimmed, ErrorCode::InvalidArgument)?;
            Some(trimmed.to_owned())
        }
        None => None,
    };

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

    let build_res = build_in_staging(
        &canonical_workspace,
        &intake,
        &work_map,
        &staging,
        validated_artifact_url,
    );
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

fn build_in_staging(
    canonical_workspace: &Path,
    intake: &IntakeDocument,
    work_map: &HashMap<String, (WorkId, String)>,
    staging: &Path,
    artifact_url: Option<String>,
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
        "INSERT INTO metadata VALUES('corpus_format', ?),('segmentation_revision', ?),('tokenization_revision', ?),('normalization_revision', ?),('dictionary_revision', ?),('equivalence_revision', ?)",
        [
            CORPUS_FORMAT,
            SEGMENTATION_REVISION,
            TOKENIZATION_REVISION,
            NORMALIZATION_REVISION,
            DICTIONARY_REVISION,
            EQUIVALENCE_REVISION,
        ],
    )
    .map_err(|e| {
        ClecError::new(
            ErrorCode::InternalError,
            format!("Metadata insert failed: {e}"),
        )
    })?;

    struct AdmittedCandidate {
        source_id: SourceId,
        work_id: WorkId,
        path: String,
        title: String,
        role: SourceRole,
        attribution: Attribution,
        content_hash: String,
        equivalence_hash: String,
        projection_kind: ProjectionKind,
        is_subtitle: bool,
        has_cues: bool,
        diagnostics_count: usize,
    }

    let mut seen_work_paths: HashSet<(String, String)> = HashSet::new();
    let mut inserted_works: HashSet<String> = HashSet::new();
    let mut inserted_blobs: HashSet<String> = HashSet::new();
    let mut admitted: Vec<AdmittedCandidate> = Vec::new();
    let mut counts = CorpusCounts {
        works: 0,
        sources: 0,
        canonical_sources: 0,
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
                "quarantined" | "unsupported" | "metadata_only" | "excluded" | "empty" | "missing"
            ) {
                return Err(ClecError::new(
                    ErrorCode::InvalidManifest,
                    format!("Unknown intake status '{}' for '{}'.", src.status, src.path),
                ));
            }
            let reason = src
                .status_reason
                .as_deref()
                .filter(|r| !r.trim().is_empty())
                .unwrap_or("Excluded by intake status.");
            record_inventory(&src.status, reason, None)?;
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

        let proj = compute_equivalence_projection(&extraction, &src.path)?;
        let _ = segment_source(&extraction, role)?;

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
            let start_ms = i64::try_from(cue.start_ms).map_err(|_| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Cue start_ms exceeds SQLite integer range.",
                )
            })?;
            let end_ms = i64::try_from(cue.end_ms).map_err(|_| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Cue end_ms exceeds SQLite integer range.",
                )
            })?;
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
                    start_ms,
                    end_ms
                ],
            )
            .map_err(|e| {
                ClecError::new(ErrorCode::InternalError, format!("Cue insert failed: {e}"))
            })?;
            counts.cues += 1;
        }

        admitted.push(AdmittedCandidate {
            source_id,
            work_id: work_id.clone(),
            path: src.path.clone(),
            title: src.title.clone(),
            role,
            attribution,
            content_hash: content_hash.clone(),
            equivalence_hash: proj.equivalence_hash,
            projection_kind: proj.kind,
            is_subtitle: is_sub,
            has_cues: !extraction.cues.is_empty(),
            diagnostics_count: extraction.diagnostics.len(),
        });

        record_inventory("indexed", "Admitted.", Some(&content_hash))?;
    }

    if counts.sources == 0 {
        return Err(ClecError::new(
            ErrorCode::EmptyCorpus,
            "No usable ready sources were admitted.",
        ));
    }

    let mut groups: BTreeMap<(String, SourceRole, String), Vec<usize>> = BTreeMap::new();
    for (idx, cand) in admitted.iter().enumerate() {
        groups
            .entry((
                cand.work_id.as_str().to_owned(),
                cand.role,
                cand.equivalence_hash.clone(),
            ))
            .or_default()
            .push(idx);
    }

    let mut canonical_indices: Vec<usize> = Vec::new();
    let mut canonical_map_rows: Vec<(usize, usize, EquivalenceBasis)> =
        Vec::with_capacity(admitted.len());
    for member_indices in groups.values() {
        let candidates: Vec<CanonicalCandidate<'_>> = member_indices
            .iter()
            .map(|&idx| {
                let c = &admitted[idx];
                CanonicalCandidate {
                    source_id: &c.source_id,
                    path: &c.path,
                    attribution: c.attribution,
                    is_subtitle: c.is_subtitle,
                    has_cues: c.has_cues,
                    diagnostics_count: c.diagnostics_count,
                }
            })
            .collect();
        let winner_pos = select_canonical_index(&candidates)
            .ok_or_else(|| ClecError::new(ErrorCode::InternalError, "Empty equivalence group."))?;
        let winner_idx = member_indices[winner_pos];
        canonical_indices.push(winner_idx);
        for &idx in member_indices {
            let basis = if member_indices.len() == 1 {
                EquivalenceBasis::UniqueInWorkRole
            } else if idx == winner_idx {
                EquivalenceBasis::CanonicalByTimingAndFormat
            } else {
                EquivalenceBasis::CollapsedToCanonical
            };
            canonical_map_rows.push((idx, winner_idx, basis));
        }
    }

    canonical_map_rows.sort_by(|(idx_a, _, _), (idx_b, _, _)| {
        let a = &admitted[*idx_a];
        let b = &admitted[*idx_b];
        (
            a.work_id.as_str(),
            a.role.as_str(),
            a.equivalence_hash.as_str(),
            a.source_id.as_str(),
        )
            .cmp(&(
                b.work_id.as_str(),
                b.role.as_str(),
                b.equivalence_hash.as_str(),
                b.source_id.as_str(),
            ))
    });

    for (idx, winner_idx, basis) in canonical_map_rows {
        let member = &admitted[idx];
        let winner_id = admitted[winner_idx].source_id.as_str();
        tx.execute(
            "INSERT INTO source_canonical_map VALUES(?,?,?,?,?)",
            params![
                member.source_id.as_str(),
                winner_id,
                member.equivalence_hash,
                member.projection_kind.as_str(),
                basis.as_str(),
            ],
        )
        .map_err(|e| {
            ClecError::new(
                ErrorCode::InternalError,
                format!("Canonical map insert failed: {e}"),
            )
        })?;
    }

    canonical_indices.sort_unstable();
    counts.canonical_sources = canonical_indices.len();

    {
        let mut stmt_blob = tx
            .prepare("SELECT raw_bytes FROM blobs WHERE content_hash = ?1")
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InternalError,
                    format!("Blob lookup prepare failed: {e}"),
                )
            })?;
        let mut stmt_passage = tx
            .prepare("INSERT INTO passages VALUES(?,?,?,?,?,?,?,?,?)")
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InternalError,
                    format!("Passage insert prepare failed: {e}"),
                )
            })?;
        let mut stmt_span = tx
            .prepare("INSERT INTO passage_spans VALUES(?,?,?,?,?)")
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InternalError,
                    format!("Span insert prepare failed: {e}"),
                )
            })?;
        let mut stmt_fts = tx
            .prepare("INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(?,?,?)")
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InternalError,
                    format!("FTS insert prepare failed: {e}"),
                )
            })?;

        for idx in canonical_indices {
            let cand = &admitted[idx];
            let raw_bytes: Vec<u8> = stmt_blob
                .query_row([cand.content_hash.as_str()], |r| r.get(0))
                .map_err(|e| {
                    ClecError::new(ErrorCode::InternalError, format!("Blob read failed: {e}"))
                })?;
            let extraction = extract_source(&raw_bytes, cand.is_subtitle)?;
            let drafts = segment_source(&extraction, cand.role)?;

            let derived_ids: Vec<PassageId> = drafts
                .iter()
                .map(|d| PassageId::derive(&cand.source_id, d.ordinal, &d.spans))
                .collect();

            let title_toks = index_tokens_string(&cand.title);
            for (d_idx, draft) in drafts.iter().enumerate() {
                let pid = &derived_ids[d_idx];
                let continued_from = if draft.is_continuation && d_idx > 0 {
                    Some(derived_ids[d_idx - 1].as_str())
                } else {
                    None
                };
                let continued_to = if d_idx + 1 < drafts.len() && drafts[d_idx + 1].is_continuation
                {
                    Some(derived_ids[d_idx + 1].as_str())
                } else {
                    None
                };

                stmt_passage
                    .execute(params![
                        pid.as_str(),
                        cand.source_id.as_str(),
                        cand.work_id.as_str(),
                        draft.ordinal as i64,
                        draft.boundary.as_str(),
                        i64::from(draft.is_continuation),
                        continued_from,
                        continued_to,
                        draft.text
                    ])
                    .map_err(|e| {
                        ClecError::new(
                            ErrorCode::InternalError,
                            format!("Passage insert failed: {e}"),
                        )
                    })?;
                let rowid = tx.last_insert_rowid();

                for (span_ord, span) in draft.spans.iter().enumerate() {
                    let span_val: &ByteSpan = span;
                    stmt_span
                        .execute(params![
                            pid.as_str(),
                            span_ord as i64,
                            span_val.start_byte() as i64,
                            span_val.end_byte() as i64,
                            span_val.cue_ordinal().map(|v| v as i64)
                        ])
                        .map_err(|e| {
                            ClecError::new(
                                ErrorCode::InternalError,
                                format!("Span insert failed: {e}"),
                            )
                        })?;
                }

                stmt_fts
                    .execute(params![rowid, title_toks, index_tokens_string(&draft.text)])
                    .map_err(|e| {
                        ClecError::new(ErrorCode::InternalError, format!("FTS insert failed: {e}"))
                    })?;
                counts.passages += 1;
            }
        }
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
        tokenization_revision: TOKENIZATION_REVISION.to_owned(),
        normalization_revision: NORMALIZATION_REVISION.to_owned(),
        dictionary_revision: DICTIONARY_REVISION.to_owned(),
        equivalence_revision: EQUIVALENCE_REVISION.to_owned(),
        artifact: "corpus.sqlite.zst".to_owned(),
        artifact_url,
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

static VALIDATE_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

struct StagingTempDir(PathBuf);

impl StagingTempDir {
    fn create() -> Result<Self, ClecError> {
        let base = std::env::temp_dir();
        fs::create_dir_all(&base).map_err(map_io)?;
        for _ in 0..32 {
            let seq = VALIDATE_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = base.join(format!(".clec-validate-{}-{seq}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(map_io(e)),
            }
        }
        Err(ClecError::new(
            ErrorCode::IoError,
            "Failed to allocate unique temporary staging directory.",
        ))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for StagingTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn validate_sqlite_snapshot(db_path: &Path) -> Result<SnapshotValidationReceipt, ClecError> {
    let canonical_path = fs::canonicalize(db_path).map_err(|e| {
        ClecError::new(
            ErrorCode::IoError,
            format!("Cannot resolve SQLite path {}: {e}", db_path.display()),
        )
    })?;
    if !canonical_path.is_file() {
        return Err(ClecError::new(
            ErrorCode::IoError,
            format!("SQLite path {} is not a file.", canonical_path.display()),
        ));
    }

    let staging_dir = StagingTempDir::create()?;
    let staging_sqlite = staging_dir.path().join("staging.sqlite");
    let (db_bytes, db_sha256_str) = copy_and_hash_readonly(&canonical_path, &staging_sqlite)?;
    let db_sha256 = ReleaseHash::parse(&db_sha256_str)?;

    let validation_res = (|| -> Result<CorpusCounts, ClecError> {
        if db_bytes == 0 || db_bytes > MAX_ARTIFACT_BYTES {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "SQLite snapshot byte size is zero or exceeds 2 GiB cap.",
            ));
        }
        let store = CorpusStore::open_readonly(&staging_sqlite, db_sha256.clone())?;
        let counts = store.counts()?;
        drop(store);
        CorpusStore::validate_staging_db(&staging_sqlite, db_sha256.clone(), &counts)?;
        Ok(counts)
    })();

    let (valid, counts, error_code, error_message) = match validation_res {
        Ok(c) => (true, Some(c), None, None),
        Err(e) => (false, None, Some(e.code), Some(e.message)),
    };

    Ok(SnapshotValidationReceipt {
        schema_version: SCHEMA_VERSION,
        validator_kind: VALIDATOR_KIND.to_owned(),
        package_version: env!("CARGO_PKG_VERSION").to_owned(),
        corpus_format: CORPUS_FORMAT.to_owned(),
        segmentation_revision: SEGMENTATION_REVISION.to_owned(),
        tokenization_revision: TOKENIZATION_REVISION.to_owned(),
        normalization_revision: NORMALIZATION_REVISION.to_owned(),
        dictionary_revision: DICTIONARY_REVISION.to_owned(),
        equivalence_revision: EQUIVALENCE_REVISION.to_owned(),
        db_path: canonical_path.display().to_string(),
        db_bytes,
        db_sha256,
        valid,
        counts,
        error_code,
        error_message,
    })
}

fn copy_and_hash_readonly(src_path: &Path, dst_path: &Path) -> Result<(u64, String), ClecError> {
    let mut src = File::open(src_path).map_err(map_io)?;
    let mut dst = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(dst_path)
        .map_err(map_io)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65_536];
    let mut total = 0u64;
    loop {
        let n = src.read(&mut buf).map_err(map_io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        dst.write_all(&buf[..n]).map_err(map_io)?;
        total += n as u64;
    }
    dst.flush().map_err(map_io)?;
    Ok((total, crate::domain::hex_encode(&hasher.finalize())))
}

pub fn file_size_and_sha256(path: &Path) -> Result<(u64, String), ClecError> {
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

fn open_existing_store(
    data_dir: &Path,
    state: &ActiveState,
    release_pin: Option<&ReleaseHash>,
) -> Result<CorpusStore, ClecError> {
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
    CorpusStore::open_readonly(&db_path, state.release.clone())
}

pub(crate) fn ensure_current_store(
    data_dir: &Path,
    network_policy: NetworkPolicy,
    default_origin: Option<&str>,
    transfer_policy: &TransferPolicy,
    release_pin: Option<&ReleaseHash>,
) -> Result<CorpusStore, ClecError> {
    if let Some(state) = read_active_state(data_dir)? {
        return open_existing_store(data_dir, &state, release_pin);
    }

    if network_policy == NetworkPolicy::Offline {
        return Err(ClecError::new(
            ErrorCode::NoData,
            "No active corpus snapshot in --data-dir and --offline prevents bootstrap. Run `clec sync --manifest PATH` first.",
        ));
    }
    let Some(origin_url) = default_origin else {
        return Err(ClecError::new(
            ErrorCode::NoData,
            "No active corpus snapshot in --data-dir and no built-in default manifest URL is configured. Run `clec sync --manifest PATH_OR_HTTPS_URL` first.",
        ));
    };

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
            "Another sync or bootstrap process currently holds the lock on --data-dir.",
        )
    })?;

    let res = (|| -> Result<CorpusStore, ClecError> {
        if let Some(state) = read_active_state(data_dir)? {
            return open_existing_store(data_dir, &state, release_pin);
        }
        sync_locked(
            data_dir,
            None,
            network_policy,
            Some(origin_url),
            transfer_policy,
            |_| Ok(()),
        )?;
        let installed = read_active_state(data_dir)?.ok_or_else(|| {
            ClecError::new(
                ErrorCode::InternalError,
                "Bootstrap sync finished without active state.",
            )
        })?;
        open_existing_store(data_dir, &installed, release_pin)
    })();

    let _ = lock_file.unlock();
    res
}

pub(crate) fn sync_dry_run(
    data_dir: &Path,
    manifest_arg: Option<&str>,
    network_policy: NetworkPolicy,
    default_origin: Option<&str>,
    transfer_policy: &TransferPolicy,
) -> Result<SyncDryRunData, ClecError> {
    let prev_state_res = read_active_state(data_dir);
    let location = resolve_sync_location(manifest_arg, &prev_state_res, default_origin)?;
    let loaded = load_manifest(&location, network_policy, transfer_policy)?;
    let prev_state = prev_state_res.ok().flatten();
    let active_db = data_dir.join(format!("{}.sqlite", loaded.manifest.sha256.as_str()));
    let is_active = prev_state
        .as_ref()
        .is_some_and(|s| s.release == loaded.manifest.sha256)
        && active_db.is_file();
    Ok(SyncDryRunData {
        dry_run: true,
        manifest_path: loaded.persistent_origin,
        release: loaded.manifest.sha256,
        corpus_format: loaded.manifest.corpus_format,
        bytes: loaded.manifest.bytes,
        compressed_bytes: loaded.manifest.compressed_bytes,
        counts: loaded.manifest.counts,
        is_active,
    })
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
    sync_with_prepare(
        data_dir,
        manifest_arg,
        NetworkPolicy::Allowed,
        None,
        &TransferPolicy::shipped(),
        |data| Ok(data.clone()),
    )
}

pub(crate) fn sync_with_prepare<T, F>(
    data_dir: &Path,
    manifest_arg: Option<&str>,
    network_policy: NetworkPolicy,
    default_origin: Option<&str>,
    transfer_policy: &TransferPolicy,
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

    let result = sync_locked(
        data_dir,
        manifest_arg,
        network_policy,
        default_origin,
        transfer_policy,
        prepare_output,
    );
    let _ = lock_file.unlock();
    result
}

fn resolve_sync_location(
    manifest_arg: Option<&str>,
    prev_state_res: &Result<Option<ActiveState>, ClecError>,
    default_origin: Option<&str>,
) -> Result<ManifestLocation, ClecError> {
    match manifest_arg {
        Some(raw) => ManifestLocation::parse(raw),
        None => {
            let prev = prev_state_res.as_ref().map_err(Clone::clone)?;
            if let Some(state) = prev {
                ManifestLocation::parse(&state.manifest_path).map_err(|e| {
                    ClecError::new(
                        ErrorCode::InvalidPackage,
                        format!("Invalid saved manifestPath in active.json: {e}"),
                    )
                })
            } else if let Some(default_url) = default_origin {
                ManifestLocation::parse(default_url)
            } else {
                Err(ClecError::new(
                    ErrorCode::NoData,
                    "No manifest origin is configured. Pass --manifest PATH_OR_HTTPS_URL.",
                ))
            }
        }
    }
}

fn sync_locked<T, F>(
    data_dir: &Path,
    manifest_arg: Option<&str>,
    network_policy: NetworkPolicy,
    default_origin: Option<&str>,
    transfer_policy: &TransferPolicy,
    prepare_output: F,
) -> Result<T, ClecError>
where
    F: FnOnce(&SyncData) -> Result<T, ClecError>,
{
    cleanup_stale_staging(data_dir);
    let prev_state_res = read_active_state(data_dir);
    let location = resolve_sync_location(manifest_arg, &prev_state_res, default_origin)?;
    let loaded = load_manifest(&location, network_policy, transfer_policy)?;
    let acquired = acquire_artifact(&loaded, data_dir, network_policy, transfer_policy)?;

    let manifest = loaded.manifest;
    let manifest_path_str = loaded.persistent_origin;

    let prev_state = prev_state_res.ok().flatten();
    let prev_release = prev_state.as_ref().map(|s| s.release.clone());

    let existing_path = data_dir.join(format!("{}.sqlite", manifest.sha256.as_str()));
    let existing_bytes_opt = if prev_state
        .as_ref()
        .is_some_and(|state| state.release == manifest.sha256)
        && existing_path.is_file()
        && CorpusStore::open_readonly(&existing_path, manifest.sha256.clone())
            .is_ok_and(|existing| existing.counts().ok().as_ref() == Some(&manifest.counts))
    {
        file_size_and_sha256(&existing_path)
            .ok()
            .filter(|(bytes, sha)| *bytes == manifest.bytes && sha == manifest.sha256.as_str())
            .map(|(bytes, _)| bytes)
    } else {
        None
    };

    if let Some(existing_bytes) = existing_bytes_opt {
        stream_verify_zstd_artifact(acquired.path(), &manifest, None)?;
        drop(acquired);

        if prev_state
            .as_ref()
            .is_some_and(|state| state.manifest_path == manifest_path_str)
        {
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

        return commit_active_state(
            data_dir,
            &existing_path,
            existing_bytes,
            &manifest,
            manifest_path_str,
            true,
            prepare_output,
        );
    }

    let staging_db = data_dir.join(".incoming.sqlite.tmp");
    let _ = fs::remove_file(&staging_db);
    let final_db = data_dir.join(format!("{}.sqlite", manifest.sha256.as_str()));
    let active_tmp_path = data_dir.join(".active.tmp");
    let _ = fs::remove_file(&active_tmp_path);
    let remove_final_on_err = prev_release.as_ref() != Some(&manifest.sha256);

    let install_res = (|| -> Result<T, ClecError> {
        let mut dst_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging_db)
            .map_err(map_io)?;
        let total = stream_verify_zstd_artifact(acquired.path(), &manifest, Some(&mut dst_file))?;
        drop(dst_file);
        drop(acquired);

        CorpusStore::validate_staging_db(&staging_db, manifest.sha256.clone(), &manifest.counts)?;

        fs::rename(&staging_db, &final_db).map_err(map_io)?;

        commit_active_state(
            data_dir,
            &final_db,
            total,
            &manifest,
            manifest_path_str,
            false,
            prepare_output,
        )
    })();

    if install_res.is_err() {
        let _ = fs::remove_file(&staging_db);
        let _ = fs::remove_file(&active_tmp_path);
        if remove_final_on_err {
            let _ = fs::remove_file(&final_db);
        }
        return install_res;
    }

    cleanup_old_releases(data_dir, manifest.sha256.as_str());
    install_res
}

fn stream_verify_zstd_artifact(
    artifact_path: &Path,
    manifest: &ReleaseManifest,
    mut out_file: Option<&mut File>,
) -> Result<u64, ClecError> {
    let src_file = File::open(artifact_path).map_err(map_io)?;
    let mut decoder = zstd::stream::Decoder::new(BufReader::new(src_file)).map_err(|e| {
        ClecError::new(
            ErrorCode::InvalidPackage,
            format!("Invalid zstd stream: {e}"),
        )
    })?;
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
        if let Some(dst) = out_file.as_deref_mut() {
            dst.write_all(&buf[..n]).map_err(map_io)?;
        }
    }
    if let Some(dst) = out_file {
        dst.sync_all().map_err(map_io)?;
    }

    let decomp_sha = crate::domain::hex_encode(&hasher.finalize());
    if total != manifest.bytes || decomp_sha != manifest.sha256.as_str() {
        return Err(ClecError::new(
            ErrorCode::IntegrityMismatch,
            "Decompressed SQLite size or SHA-256 does not match manifest.",
        ));
    }
    Ok(total)
}

fn commit_active_state<T, F>(
    data_dir: &Path,
    final_db: &Path,
    final_db_len: u64,
    manifest: &ReleaseManifest,
    manifest_path_str: String,
    reused: bool,
    prepare_output: F,
) -> Result<T, ClecError>
where
    F: FnOnce(&SyncData) -> Result<T, ClecError>,
{
    let (active_tmp, active_tmp_len) =
        write_active_state_tmp(data_dir, &manifest.sha256, &manifest_path_str)?;
    let commit_res = (|| -> Result<T, ClecError> {
        let storage_bytes =
            compute_projected_managed_bytes(data_dir, final_db, final_db_len, active_tmp_len)?;
        let sync_data = SyncData {
            release: manifest.sha256.clone(),
            corpus_format: manifest.corpus_format.clone(),
            manifest_path: manifest_path_str,
            counts: manifest.counts.clone(),
            reused,
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
    commit_res
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
            || is_staging_temp_name(&s)
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

pub(crate) fn map_io(err: std::io::Error) -> ClecError {
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

        let budget_err = sync_with_prepare(
            &data_dir,
            Some(&m_b_path),
            NetworkPolicy::Allowed,
            None,
            &TransferPolicy::shipped(),
            |_| {
                Err::<(), ClecError>(ClecError::new(
                    ErrorCode::OutputBudgetTooSmall,
                    "simulated budget failure before commit",
                ))
            },
        )
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

    #[test]
    fn reuse_validates_incoming_zstd_stream_and_decompressed_hash_before_mutating_state() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), "alpha reuse validation content").unwrap();
        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            r#"{"schemaVersion":1,"works":[{"key":"wa","title":"A"}],"sources":[{"work":"wa","path":"a.txt","title":"A","role":"document","attribution":"authored_fixture","quality":"fixture","status":"ready"}]}"#,
        )
        .unwrap();

        let rel_a = tmp.path().join("rel_a");
        let m_a = publish_release(&ws, &intake, &rel_a).unwrap();
        let rel_a_manifest = fs::canonicalize(rel_a.join("manifest.json"))
            .unwrap()
            .display()
            .to_string();

        let data_dir = tmp.path().join("data");
        let first = sync_local(&data_dir, Some(&rel_a_manifest)).unwrap();
        assert!(!first.reused);

        let bad_zstd_dir = tmp.path().join("bad_zstd_rel");
        fs::create_dir_all(&bad_zstd_dir).unwrap();
        let bad_bytes = b"not a zstd stream";
        let bad_zstd_path = bad_zstd_dir.join("corpus.sqlite.zst");
        fs::write(&bad_zstd_path, bad_bytes).unwrap();
        let mut m_bad_zstd = m_a.clone();
        m_bad_zstd.compressed_bytes = bad_bytes.len() as u64;
        m_bad_zstd.compressed_sha256 = sha256_hex(bad_bytes);
        let bad_zstd_manifest = bad_zstd_dir.join("manifest.json");
        fs::write(
            &bad_zstd_manifest,
            serde_json::to_vec_pretty(&m_bad_zstd).unwrap(),
        )
        .unwrap();

        let err_cached =
            sync_local(&data_dir, Some(&bad_zstd_manifest.display().to_string())).unwrap_err();
        assert_eq!(err_cached.code, ErrorCode::InvalidPackage);
        let st_after_bad = data_dir_status(&data_dir).unwrap();
        assert_eq!(st_after_bad.active_release.as_ref(), Some(&m_a.sha256));
        assert_eq!(
            st_after_bad.manifest_path.as_deref(),
            Some(rel_a_manifest.as_str())
        );

        let fresh_dir = tmp.path().join("fresh_data");
        let err_fresh =
            sync_local(&fresh_dir, Some(&bad_zstd_manifest.display().to_string())).unwrap_err();
        assert_eq!(err_fresh.code, ErrorCode::InvalidPackage);
        assert!(!fresh_dir.join("active.json").exists());

        let wrong_payload_dir = tmp.path().join("wrong_payload_rel");
        fs::create_dir_all(&wrong_payload_dir).unwrap();
        let wrong_zst = zstd::stream::encode_all(&b"valid zstd wrong sqlite"[..], 3).unwrap();
        fs::write(wrong_payload_dir.join("corpus.sqlite.zst"), &wrong_zst).unwrap();
        let mut m_wrong_payload = m_a.clone();
        m_wrong_payload.compressed_bytes = wrong_zst.len() as u64;
        m_wrong_payload.compressed_sha256 = sha256_hex(&wrong_zst);
        let wrong_payload_manifest = wrong_payload_dir.join("manifest.json");
        fs::write(
            &wrong_payload_manifest,
            serde_json::to_vec_pretty(&m_wrong_payload).unwrap(),
        )
        .unwrap();

        let err_wrong = sync_local(
            &data_dir,
            Some(&wrong_payload_manifest.display().to_string()),
        )
        .unwrap_err();
        assert_eq!(err_wrong.code, ErrorCode::IntegrityMismatch);
        let st_after_wrong = data_dir_status(&data_dir).unwrap();
        assert_eq!(
            st_after_wrong.manifest_path.as_deref(),
            Some(rel_a_manifest.as_str())
        );

        let valid_copy_dir = tmp.path().join("valid_copy_rel");
        fs::create_dir_all(&valid_copy_dir).unwrap();
        fs::copy(
            rel_a.join("corpus.sqlite.zst"),
            valid_copy_dir.join("corpus.sqlite.zst"),
        )
        .unwrap();
        fs::copy(
            rel_a.join("manifest.json"),
            valid_copy_dir.join("manifest.json"),
        )
        .unwrap();
        let valid_copy_manifest = fs::canonicalize(valid_copy_dir.join("manifest.json"))
            .unwrap()
            .display()
            .to_string();
        let reused_copy = sync_local(&data_dir, Some(&valid_copy_manifest)).unwrap();
        assert!(reused_copy.reused);
        let st_after_valid_copy = data_dir_status(&data_dir).unwrap();
        assert_eq!(
            st_after_valid_copy.manifest_path.as_deref(),
            Some(valid_copy_manifest.as_str())
        );

        fs::write(valid_copy_dir.join("corpus.sqlite.zst"), bad_bytes).unwrap();
        fs::write(
            valid_copy_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&m_bad_zstd).unwrap(),
        )
        .unwrap();
        let err_same_path = sync_local(&data_dir, Some(&valid_copy_manifest)).unwrap_err();
        assert_eq!(err_same_path.code, ErrorCode::InvalidPackage);
    }

    #[test]
    fn publish_is_byte_deterministic_across_repeats_and_input_permutations() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();

        let mut works = Vec::new();
        let mut sources = Vec::new();
        for w in 0..4 {
            let wk = format!("work-{w:02}");
            works.push(serde_json::json!({"key": wk, "title": format!("Work {w:02}")}));

            let body = format!("工作{w}測試重複內容\n資產配置討論");
            let srt =
                format!("1\n00:00:01,000 --> 00:00:03,000\n工作{w}測試重複內容\n資產配置討論\n");
            let md = format!(
                "# 語音筆記：Work {w}\n\n## [00:00:01.000 – 00:00:03.000]\n工作{w}測試重複內容\n資產配置討論\n"
            );
            fs::write(ws.join(format!("ep{w}.srt")), &srt).unwrap();
            fs::write(ws.join(format!("ep{w}.txt")), &body).unwrap();
            fs::write(ws.join(format!("ep{w}.md")), &md).unwrap();
            fs::write(
                ws.join(format!("sum{w}.txt")),
                format!("工作{w}摘要獨立內容"),
            )
            .unwrap();

            for (path, role) in [
                (format!("ep{w}.srt"), "transcript"),
                (format!("ep{w}.txt"), "transcript"),
                (format!("ep{w}.md"), "transcript"),
                (format!("sum{w}.txt"), "summary"),
            ] {
                sources.push(serde_json::json!({
                    "work": wk,
                    "path": path,
                    "title": format!("{wk} {path}"),
                    "role": role,
                    "attribution": "authored_fixture",
                    "quality": "fixture",
                    "status": "ready"
                }));
            }
        }
        sources.push(serde_json::json!({
            "work": "work-00",
            "path": "excluded.bin",
            "title": "Excluded",
            "role": "document",
            "attribution": "authored_fixture",
            "quality": "fixture",
            "status": "unsupported",
            "statusReason": "fixture"
        }));

        let intake_forward = tmp.path().join("intake-fwd.json");
        fs::write(
            &intake_forward,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "works": works,
                "sources": sources,
            }))
            .unwrap(),
        )
        .unwrap();

        works.reverse();
        sources.reverse();
        let intake_reversed = tmp.path().join("intake-rev.json");
        fs::write(
            &intake_reversed,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "works": works,
                "sources": sources,
            }))
            .unwrap(),
        )
        .unwrap();

        let mut manifests = Vec::new();
        let mut zst_payloads = Vec::new();
        let mut sqlite_payloads = Vec::new();
        for (idx, intake_path) in [
            &intake_forward,
            &intake_forward,
            &intake_forward,
            &intake_reversed,
        ]
        .into_iter()
        .enumerate()
        {
            let out = tmp.path().join(format!("rel-{idx}"));
            let m = publish_release(&ws, intake_path, &out).unwrap();
            assert_eq!(m.counts.works, 4);
            assert_eq!(m.counts.sources, 16);
            assert_eq!(m.counts.canonical_sources, 8);
            let zst_bytes = fs::read(out.join("corpus.sqlite.zst")).unwrap();
            let sqlite_bytes = zstd::stream::decode_all(&zst_bytes[..]).unwrap();
            manifests.push(m);
            zst_payloads.push(zst_bytes);
            sqlite_payloads.push(sqlite_bytes);
        }

        for i in 1..manifests.len() {
            assert_eq!(manifests[i].sha256, manifests[0].sha256);
            assert_eq!(
                manifests[i].compressed_sha256,
                manifests[0].compressed_sha256
            );
            assert_eq!(manifests[i].counts, manifests[0].counts);
            assert_eq!(sqlite_payloads[i], sqlite_payloads[0]);
            assert_eq!(zst_payloads[i], zst_payloads[0]);
        }
    }

    #[test]
    fn validate_sqlite_snapshot_accepts_vacuumed_and_rejects_fts_shadow_corruptions_without_mutating_sources()
     {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), "0050與QQQ投資討論\n每年4%提領原則\n").unwrap();
        fs::write(ws.join("b.txt"), "退休生活費規劃與資產配置\n").unwrap();

        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            r#"{
              "schemaVersion": 1,
              "works": [
                { "key": "w1", "title": "Work 1" },
                { "key": "w2", "title": "Work 2" }
              ],
              "sources": [
                {
                  "work": "w1",
                  "path": "a.txt",
                  "title": "A",
                  "role": "document",
                  "attribution": "authored_fixture",
                  "quality": "fixture",
                  "status": "ready"
                },
                {
                  "work": "w2",
                  "path": "b.txt",
                  "title": "B",
                  "role": "document",
                  "attribution": "authored_fixture",
                  "quality": "fixture",
                  "status": "ready"
                }
              ]
            }"#,
        )
        .unwrap();

        let rel = tmp.path().join("rel");
        let manifest = publish_release(&ws, &intake, &rel).unwrap();
        let data_dir = tmp.path().join("data");
        sync_local(
            &data_dir,
            Some(&rel.join("manifest.json").display().to_string()),
        )
        .unwrap();
        let clean_db = data_dir.join(format!("{}.sqlite", manifest.sha256));
        let clean_bytes = fs::read(&clean_db).unwrap();

        let vac_db = tmp.path().join("vacuumed.sqlite");
        fs::copy(&clean_db, &vac_db).unwrap();
        {
            let conn = Connection::open(&vac_db).unwrap();
            conn.execute_batch("PRAGMA page_size=8192; VACUUM;")
                .unwrap();
        }
        let vac_bytes = fs::read(&vac_db).unwrap();
        assert_ne!(clean_bytes, vac_bytes);

        let bad_data_db = tmp.path().join("bad_search_data.sqlite");
        fs::copy(&clean_db, &bad_data_db).unwrap();
        {
            let conn = Connection::open(&bad_data_db).unwrap();
            conn.execute("UPDATE search_data SET block=X'000000' WHERE id=1", [])
                .unwrap();
        }
        let bad_data_bytes = fs::read(&bad_data_db).unwrap();

        let bad_docsize_db = tmp.path().join("bad_search_docsize.sqlite");
        fs::copy(&clean_db, &bad_docsize_db).unwrap();
        {
            let conn = Connection::open(&bad_docsize_db).unwrap();
            conn.execute("UPDATE search_docsize SET sz=X'0000' WHERE id=1", [])
                .unwrap();
        }
        let bad_docsize_bytes = fs::read(&bad_docsize_db).unwrap();

        let clean_receipt = validate_sqlite_snapshot(&clean_db).unwrap();
        assert!(clean_receipt.valid);
        assert_eq!(clean_receipt.db_sha256, manifest.sha256);
        assert_eq!(clean_receipt.counts, Some(manifest.counts.clone()));
        assert_eq!(fs::read(&clean_db).unwrap(), clean_bytes);

        let vac_receipt = validate_sqlite_snapshot(&vac_db).unwrap();
        assert!(vac_receipt.valid);
        assert_ne!(vac_receipt.db_sha256, clean_receipt.db_sha256);
        assert_eq!(vac_receipt.counts, Some(manifest.counts));
        assert_eq!(fs::read(&vac_db).unwrap(), vac_bytes);

        let bad_data_receipt = validate_sqlite_snapshot(&bad_data_db).unwrap();
        assert!(!bad_data_receipt.valid);
        assert_eq!(
            bad_data_receipt.error_code,
            Some(ErrorCode::IntegrityMismatch)
        );
        assert_eq!(fs::read(&bad_data_db).unwrap(), bad_data_bytes);

        let bad_docsize_receipt = validate_sqlite_snapshot(&bad_docsize_db).unwrap();
        assert!(!bad_docsize_receipt.valid);
        assert_eq!(
            bad_docsize_receipt.error_code,
            Some(ErrorCode::IntegrityMismatch)
        );
        assert_eq!(fs::read(&bad_docsize_db).unwrap(), bad_docsize_bytes);
    }

    #[test]
    fn publish_optional_artifact_url_preserves_db_bytes_and_local_sync_uses_sibling_offline() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), "optional artifactUrl local sync test").unwrap();
        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            r#"{"schemaVersion":1,"works":[{"key":"w1","title":"W1"}],"sources":[{"work":"w1","path":"a.txt","title":"A","role":"document","attribution":"authored_fixture","quality":"fixture","status":"ready"}]}"#,
        )
        .unwrap();

        let rel_plain = tmp.path().join("rel-plain");
        let rel_url = tmp.path().join("rel-url");
        let m_plain = publish_release(&ws, &intake, &rel_plain).unwrap();
        let m_url = publish_release_with_artifact_url(
            &ws,
            &intake,
            &rel_url,
            Some("https://cdn.example.invalid/releases/corpus.sqlite.zst"),
        )
        .unwrap();

        assert!(m_plain.artifact_url.is_none());
        let raw_plain = fs::read_to_string(rel_plain.join("manifest.json")).unwrap();
        assert!(!raw_plain.contains("artifactUrl"));

        assert_eq!(
            m_url.artifact_url.as_deref(),
            Some("https://cdn.example.invalid/releases/corpus.sqlite.zst")
        );
        assert_eq!(m_plain.sha256, m_url.sha256);
        assert_eq!(m_plain.compressed_sha256, m_url.compressed_sha256);
        assert_eq!(
            fs::read(rel_plain.join("corpus.sqlite.zst")).unwrap(),
            fs::read(rel_url.join("corpus.sqlite.zst")).unwrap()
        );

        let data_dir = tmp.path().join("data");
        let synced = sync_with_prepare(
            &data_dir,
            Some(&rel_url.join("manifest.json").display().to_string()),
            NetworkPolicy::Offline,
            None,
            &TransferPolicy::shipped(),
            |d| Ok(d.clone()),
        )
        .unwrap();
        assert_eq!(synced.release, m_url.sha256);

        let oversized_manifest = tmp.path().join("oversized-manifest.json");
        fs::write(&oversized_manifest, vec![b' '; (1024 * 1024) + 1]).unwrap();
        let err =
            sync_local(&data_dir, Some(&oversized_manifest.display().to_string())).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidManifest);
    }

    #[test]
    fn http_sync_handles_redirects_reuse_chunked_encoding_and_shortened_timeouts() {
        use std::io::{BufRead, BufReader as IoBufReader};
        use std::net::TcpListener;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::thread;
        use std::time::Duration;

        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), "http transport fixture alpha").unwrap();
        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            r#"{"schemaVersion":1,"works":[{"key":"w1","title":"W1"}],"sources":[{"work":"w1","path":"a.txt","title":"A","role":"document","attribution":"authored_fixture","quality":"fixture","status":"ready"}]}"#,
        )
        .unwrap();
        let rel = tmp.path().join("rel");
        let manifest = publish_release(&ws, &intake, &rel).unwrap();
        let manifest_bytes = fs::read(rel.join("manifest.json")).unwrap();
        let zst_bytes = fs::read(rel.join("corpus.sqlite.zst")).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let req_count = Arc::new(AtomicUsize::new(0));
        let req_count_srv = Arc::clone(&req_count);
        let zst_srv = zst_bytes.clone();
        let manifest_srv = manifest_bytes.clone();

        let handle = thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = IoBufReader::new(stream.try_clone().unwrap());
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
                req_count_srv.fetch_add(1, AtomicOrdering::SeqCst);

                if path == "/shutdown" {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
                    break;
                } else if let Some(rest) = path.strip_prefix("/redir/") {
                    let n: usize = rest.parse().unwrap_or(0);
                    let loc = if n <= 1 {
                        "/final/manifest.json?signed=secret".to_owned()
                    } else {
                        format!("/redir/{}", n - 1)
                    };
                    let resp = format!(
                        "HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\n\r\n"
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if path.starts_with("/final/manifest.json") {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        manifest_srv.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&manifest_srv);
                } else if path == "/final/corpus.sqlite.zst" {
                    let _ =
                        stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
                    for chunk in zst_srv.chunks(64) {
                        let _ = write!(stream, "{:x}\r\n", chunk.len());
                        let _ = stream.write_all(chunk);
                        let _ = stream.write_all(b"\r\n");
                    }
                    let _ = stream.write_all(b"0\r\n\r\n");
                } else if path == "/gzip/manifest.json" {
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}",
                    );
                } else if path.starts_with("/slow-headers") {
                    thread::sleep(Duration::from_millis(350));
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
                } else if path == "/trickle-body" {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
                    for _ in 0..10 {
                        let _ = stream.write_all(b"1234567890");
                        let _ = stream.flush();
                        thread::sleep(Duration::from_millis(45));
                    }
                } else {
                    let _ =
                        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                }
            }
        });

        let data_dir = tmp.path().join("data");
        let policy = TransferPolicy::shipped();

        let five_redir = format!("http://127.0.0.1:{port}/redir/5");
        let synced = sync_with_prepare(
            &data_dir,
            Some(&five_redir),
            NetworkPolicy::Allowed,
            None,
            &policy,
            |d| Ok(d.clone()),
        )
        .unwrap();
        assert_eq!(synced.release, manifest.sha256);
        assert_eq!(synced.manifest_path, five_redir);
        assert!(!data_dir.join(".incoming.zst.tmp").exists());
        assert_eq!(
            synced.storage_bytes,
            data_dir_status(&data_dir).unwrap().storage_bytes
        );

        let before_reuse = req_count.load(AtomicOrdering::SeqCst);
        let reused = sync_with_prepare(
            &data_dir,
            None,
            NetworkPolicy::Allowed,
            None,
            &policy,
            |d| Ok(d.clone()),
        )
        .unwrap();
        assert!(reused.reused);
        assert!(req_count.load(AtomicOrdering::SeqCst) > before_reuse);

        let before_offline = req_count.load(AtomicOrdering::SeqCst);
        let offline_err = sync_with_prepare(
            &data_dir,
            None,
            NetworkPolicy::Offline,
            None,
            &policy,
            |d| Ok(d.clone()),
        )
        .unwrap_err();
        assert_eq!(offline_err.code, ErrorCode::OfflineRequired);
        assert_eq!(req_count.load(AtomicOrdering::SeqCst), before_offline);

        let six_redir = format!("http://127.0.0.1:{port}/redir/6");
        let err_6 = sync_with_prepare(
            &data_dir,
            Some(&six_redir),
            NetworkPolicy::Allowed,
            None,
            &policy,
            |d| Ok(d.clone()),
        )
        .unwrap_err();
        assert_eq!(err_6.code, ErrorCode::TransferFailed);

        let gzip_url = format!("http://127.0.0.1:{port}/gzip/manifest.json");
        let err_gzip = sync_with_prepare(
            &data_dir,
            Some(&gzip_url),
            NetworkPolicy::Allowed,
            None,
            &policy,
            |d| Ok(d.clone()),
        )
        .unwrap_err();
        assert_eq!(err_gzip.code, ErrorCode::TransferFailed);

        let fast_policy = TransferPolicy {
            connect_timeout: Duration::from_millis(200),
            manifest_timeout: Duration::from_millis(150),
            artifact_timeout: Duration::from_millis(150),
            #[cfg(any(test, feature = "test-hooks"))]
            extra_root_pem: None,
        };
        let slow_err = sync_with_prepare(
            &data_dir,
            Some(&format!("http://127.0.0.1:{port}/slow-headers?sig=secret")),
            NetworkPolicy::Allowed,
            None,
            &fast_policy,
            |d| Ok(d.clone()),
        )
        .unwrap_err();
        assert_eq!(
            slow_err.code,
            ErrorCode::TransferTimeout,
            "slow_err={slow_err:?}"
        );
        assert!(!slow_err.message.contains("sig=secret"));

        let trickle_err = sync_with_prepare(
            &data_dir,
            Some(&format!("http://127.0.0.1:{port}/trickle-body")),
            NetworkPolicy::Allowed,
            None,
            &fast_policy,
            |d| Ok(d.clone()),
        )
        .unwrap_err();
        assert_eq!(
            trickle_err.code,
            ErrorCode::TransferTimeout,
            "trickle_err={trickle_err:?}"
        );

        let _ = reqwest::blocking::get(format!("http://127.0.0.1:{port}/shutdown"));
        let _ = handle.join();
    }
}
