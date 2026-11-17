use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use rusqlite::{Connection, OpenFlags, params, types::ToSql};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::domain::{
    Attribution, BoundaryKind, ByteSpan, CORPUS_FORMAT, CanonicalCandidate, ClecError,
    DICTIONARY_REVISION, DateYmd, EQUIVALENCE_REVISION, EquivalenceBasis, ErrorCode,
    NORMALIZATION_REVISION, PassageId, ProjectionKind, ReleaseHash, SEGMENTATION_REVISION,
    SourceId, SourceRole, TOKENIZATION_REVISION, WorkId, select_canonical_index, sha256_hex,
};
use crate::ingest::{
    SubtitleCue, compute_equivalence_projection, extract_source, is_subtitle_path,
    reconstruct_passage_text, segment_source,
};
use crate::lexical::{encode_fts_token, index_tokens_string, normalize_for_search};

pub(crate) const SCHEMA_SQL: &str = "
PRAGMA journal_mode=DELETE;
PRAGMA foreign_keys=ON;
CREATE TABLE metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE blobs(
  content_hash TEXT PRIMARY KEY,
  raw_bytes BLOB NOT NULL,
  byte_len INTEGER NOT NULL
);
CREATE TABLE works(
  id TEXT PRIMARY KEY,
  work_key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL
);
CREATE TABLE sources(
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  attribution TEXT NOT NULL,
  quality TEXT NOT NULL,
  date TEXT,
  date_basis TEXT,
  origin TEXT,
  content_hash TEXT NOT NULL REFERENCES blobs(content_hash)
);
CREATE TABLE source_canonical_map(
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  canonical_source_id TEXT NOT NULL REFERENCES sources(id),
  equivalence_hash TEXT NOT NULL,
  projection_kind TEXT NOT NULL,
  equivalence_basis TEXT NOT NULL
);
CREATE INDEX source_canonical_by_canon ON source_canonical_map(canonical_source_id);
CREATE TABLE source_diagnostics(
  source_id TEXT NOT NULL REFERENCES sources(id),
  ordinal INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (source_id, ordinal)
);
CREATE TABLE cues(
  source_id TEXT NOT NULL REFERENCES sources(id),
  ordinal INTEGER NOT NULL,
  original_identifier TEXT,
  raw_start_byte INTEGER NOT NULL,
  raw_end_byte INTEGER NOT NULL,
  text_start_byte INTEGER NOT NULL,
  text_end_byte INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  PRIMARY KEY (source_id, ordinal)
);
CREATE TABLE passages(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  ordinal INTEGER NOT NULL,
  boundary TEXT NOT NULL,
  is_continuation INTEGER NOT NULL,
  continued_from TEXT,
  continued_to TEXT,
  text TEXT NOT NULL
);
CREATE UNIQUE INDEX passages_source_ordinal ON passages(source_id, ordinal);
CREATE TABLE passage_spans(
  passage_id TEXT NOT NULL REFERENCES passages(id),
  span_ordinal INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  cue_ordinal INTEGER,
  PRIMARY KEY (passage_id, span_ordinal)
);
CREATE TABLE inventory(
  path TEXT NOT NULL,
  work_key TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_hash TEXT,
  PRIMARY KEY (path, work_key)
);
CREATE VIRTUAL TABLE search USING fts5(
  title_tokens,
  body_tokens,
  content='',
  tokenize='ascii'
);
";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CorpusCounts {
    pub works: usize,
    pub sources: usize,
    pub canonical_sources: usize,
    pub blobs: usize,
    pub passages: usize,
    pub cues: usize,
    pub inventory: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkRecord {
    pub work_id: WorkId,
    pub work_key: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EquivalentSourceRef {
    pub source_id: SourceId,
    pub path: String,
    pub role: SourceRole,
    pub attribution: Attribution,
    pub projection_kind: ProjectionKind,
    pub equivalence_basis: EquivalenceBasis,
    pub is_canonical: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceRecord {
    pub source_id: SourceId,
    pub work_id: WorkId,
    pub path: String,
    pub title: String,
    pub role: SourceRole,
    pub attribution: Attribution,
    pub quality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<DateYmd>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_basis: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    pub content_hash: String,
    pub canonical_source_id: SourceId,
    pub equivalence_basis: EquivalenceBasis,
    pub projection_kind: ProjectionKind,
    pub equivalence_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PassageContext {
    pub passage_id: PassageId,
    pub ordinal: usize,
    pub boundary: BoundaryKind,
    pub is_continuation: bool,
    pub spans: Vec<ByteSpan>,
    pub cues: Vec<SubtitleCue>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FindMatch {
    pub start_byte: usize,
    pub end_byte: usize,
    pub passage_ids: Vec<PassageId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PassageReadItem {
    pub passage_id: PassageId,
    pub work: WorkRecord,
    pub source: SourceRecord,
    pub ordinal: usize,
    pub boundary: BoundaryKind,
    pub is_continuation: bool,
    pub continued_from: Option<PassageId>,
    pub continued_to: Option<PassageId>,
    pub previous: Option<PassageId>,
    pub next: Option<PassageId>,
    pub spans: Vec<ByteSpan>,
    pub cues: Vec<SubtitleCue>,
    pub diagnostics: Vec<String>,
    pub text: String,
    pub context: Vec<PassageContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_matches: Option<Vec<FindMatch>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceOriginalItem {
    pub work: WorkRecord,
    pub source: SourceRecord,
    pub equivalent_sources: Vec<EquivalentSourceRef>,
    pub diagnostics: Vec<String>,
    pub passage_ids: Vec<PassageId>,
    pub byte_len: usize,
    pub original_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_matches: Option<Vec<FindMatch>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceOverviewItem {
    pub work: WorkRecord,
    pub source: SourceRecord,
    pub equivalent_sources: Vec<EquivalentSourceRef>,
    pub passage_count: usize,
    pub cue_count: usize,
    pub diagnostics: Vec<String>,
    pub passage_ids: Vec<PassageId>,
    pub canonical_passage_ids: Vec<PassageId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceListEntry {
    pub work_id: WorkId,
    pub work_key: String,
    pub work_title: String,
    pub source_id: SourceId,
    pub path: String,
    pub title: String,
    pub role: SourceRole,
    pub attribution: Attribution,
    pub quality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<DateYmd>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_basis: Option<String>,
    pub content_hash: String,
    pub canonical_source_id: SourceId,
    pub is_canonical: bool,
    pub equivalence_basis: EquivalenceBasis,
    pub equivalent_count: usize,
    pub passage_count: usize,
    pub diagnostics_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsSummary {
    pub sources_with_diagnostics: usize,
    pub total_diagnostics: usize,
}

pub(crate) struct VerifiedPassageCore {
    pub context: PassageContext,
    pub source: SourceRecord,
    pub work: WorkRecord,
    pub continued_from: Option<PassageId>,
    pub continued_to: Option<PassageId>,
}

#[derive(Debug)]
pub(crate) struct Bm25Candidate {
    pub passage_id: PassageId,
    pub work_id: WorkId,
}

pub(crate) struct CandidateFilter<'a> {
    pub work_filter: Option<&'a WorkId>,
    pub source_filter: Option<&'a SourceId>,
    pub role_filter: Option<SourceRole>,
    pub date_from: Option<&'a DateYmd>,
    pub date_to: Option<&'a DateYmd>,
}

pub(crate) struct CorpusStore {
    conn: Connection,
    pub release: ReleaseHash,
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct ReadSnapshotGuard<'a> {
    conn: &'a Connection,
}

impl Drop for ReadSnapshotGuard<'_> {
    fn drop(&mut self) {
        let _ = self.conn.execute_batch("ROLLBACK;");
    }
}

impl CorpusStore {
    pub(crate) fn open_readonly(path: &Path, release: ReleaseHash) -> Result<Self, ClecError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| {
            ClecError::new(
                ErrorCode::InvalidPackage,
                format!("Cannot open corpus SQLite: {e}"),
            )
        })?;

        conn.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("SQLite pragma failed: {e}"),
                )
            })?;

        let store = Self { conn, release };
        store.verify_format_header()?;
        Ok(store)
    }

    pub(crate) fn validate_staging_db(
        path: &Path,
        release: ReleaseHash,
        expected_counts: &CorpusCounts,
    ) -> Result<(), ClecError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| {
            ClecError::new(
                ErrorCode::InvalidPackage,
                format!("Cannot open staging corpus SQLite: {e}"),
            )
        })?;

        conn.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("SQLite pragma failed: {e}"),
                )
            })?;

        let store = Self { conn, release };
        store.validate_full(
            path.parent().unwrap_or_else(|| Path::new(".")),
            expected_counts,
        )
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn begin_read_snapshot(&self) -> Result<ReadSnapshotGuard<'_>, ClecError> {
        self.conn.execute_batch("BEGIN DEFERRED;").map_err(|e| {
            ClecError::new(
                ErrorCode::InvalidPackage,
                format!("Failed to start SQLite read snapshot: {e}"),
            )
        })?;
        let guard = ReadSnapshotGuard { conn: &self.conn };
        let _: i64 = self
            .conn
            .query_row("SELECT count(*) FROM metadata", [], |r| r.get(0))
            .map_err(|e| map_sql_query_err(e, "Failed to pin SQLite read snapshot"))?;
        Ok(guard)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn set_deadline_progress_handler(&mut self, deadline: Instant) {
        let _ = self
            .conn
            .progress_handler(64, Some(move || Instant::now() >= deadline));
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn clear_deadline_progress_handler(&mut self) {
        let _ = self.conn.progress_handler(0, None::<fn() -> bool>);
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn passage_count(&self) -> Result<usize, ClecError> {
        let n: i64 = self
            .conn
            .query_row("SELECT count(*) FROM passages", [], |r| r.get(0))
            .map_err(|e| map_sql_query_err(e, "Passage count failed"))?;
        usize::try_from(n)
            .map_err(|_| ClecError::new(ErrorCode::InvalidPackage, "Negative passage count"))
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn body_term_document_frequency(&self, term: &str) -> Result<usize, ClecError> {
        let fts_expr = format!("body_tokens : \"{}\"", encode_fts_token(term));
        let n: i64 = self
            .conn
            .query_row(
                "SELECT count(*) FROM search WHERE search MATCH ?1",
                [fts_expr],
                |r| r.get(0),
            )
            .map_err(|e| map_sql_query_err(e, "Term document frequency query failed"))?;
        usize::try_from(n).map_err(|_| {
            ClecError::new(
                ErrorCode::InvalidPackage,
                "Negative term document frequency",
            )
        })
    }

    pub(crate) fn query_bm25_candidates(
        &self,
        fts_query: &str,
        filter: &CandidateFilter<'_>,
        limit: usize,
    ) -> Result<Vec<Bm25Candidate>, ClecError> {
        self.query_bm25_candidates_inner(fts_query, filter, &[], limit)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn query_bm25_candidates_excluding(
        &self,
        fts_query: &str,
        filter: &CandidateFilter<'_>,
        excluded_ids: &[PassageId],
        limit: usize,
    ) -> Result<Vec<Bm25Candidate>, ClecError> {
        self.query_bm25_candidates_inner(fts_query, filter, excluded_ids, limit)
    }

    fn query_bm25_candidates_inner(
        &self,
        fts_query: &str,
        filter: &CandidateFilter<'_>,
        excluded_ids: &[PassageId],
        limit: usize,
    ) -> Result<Vec<Bm25Candidate>, ClecError> {
        let mut sql = String::from(
            "SELECT p.id, p.work_id, bm25(search, 4.0, 1.0) AS score
             FROM search
             JOIN passages p ON p.rowid = search.rowid
             JOIN sources s ON s.id = p.source_id
             WHERE search MATCH ?1
               AND (?2 IS NULL OR p.work_id = ?2)
               AND (?3 IS NULL OR p.source_id = ?3)
               AND (?4 IS NULL OR s.role = ?4)
               AND (?5 IS NULL OR s.date >= ?5)
               AND (?6 IS NULL OR s.date <= ?6)",
        );
        if !excluded_ids.is_empty() {
            sql.push_str(" AND p.id NOT IN (");
            for idx in 0..excluded_ids.len() {
                if idx > 0 {
                    sql.push(',');
                }
                sql.push('?');
                sql.push_str(&(8 + idx).to_string());
            }
            sql.push(')');
        }
        sql.push_str(" ORDER BY score ASC, p.id ASC LIMIT ?7");

        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| map_sql_query_err(e, "Search query failed"))?;

        let work_arg = filter.work_filter.map(WorkId::as_str);
        let source_arg = filter.source_filter.map(SourceId::as_str);
        let role_arg = filter.role_filter.map(SourceRole::as_str);
        let from_arg = filter.date_from.map(DateYmd::as_str);
        let to_arg = filter.date_to.map(DateYmd::as_str);
        let limit_i64 = i64::try_from(limit).unwrap_or(i64::MAX);

        let mut bound: Vec<&dyn ToSql> = Vec::with_capacity(7 + excluded_ids.len());
        bound.push(&fts_query);
        bound.push(&work_arg);
        bound.push(&source_arg);
        bound.push(&role_arg);
        bound.push(&from_arg);
        bound.push(&to_arg);
        bound.push(&limit_i64);
        for pid in excluded_ids {
            bound.push(pid.as_str_ref());
        }

        let mut rows = stmt
            .query(rusqlite::params_from_iter(bound))
            .map_err(|e| map_sql_query_err(e, "Search execution failed"))?;

        let mut candidates = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|e| map_sql_query_err(e, "Search row error"))?
        {
            let pid_str: String = row.get(0).map_err(map_sql_pkg)?;
            let wid_str: String = row.get(1).map_err(map_sql_pkg)?;
            candidates.push(Bm25Candidate {
                passage_id: PassageId::parse(&pid_str)?,
                work_id: WorkId::parse(&wid_str)?,
            });
        }
        Ok(candidates)
    }

    fn verify_format_header(&self) -> Result<(), ClecError> {
        let expect_meta = |key: &str, expected: &str, err_msg: &str| -> Result<(), ClecError> {
            let actual: Option<String> = self
                .conn
                .query_row("SELECT value FROM metadata WHERE key=?", [key], |row| {
                    row.get(0)
                })
                .ok();
            if actual.as_deref() != Some(expected) {
                return Err(ClecError::new(ErrorCode::InvalidPackage, err_msg));
            }
            Ok(())
        };

        expect_meta(
            "corpus_format",
            CORPUS_FORMAT,
            "Unsupported corpus format (expected clec-native-v2; legacy format revisions 1, 2, 3, and clec-native-v1 are unsupported).",
        )?;
        expect_meta(
            "segmentation_revision",
            SEGMENTATION_REVISION,
            "Unsupported corpus segmentation revision.",
        )?;
        expect_meta(
            "tokenization_revision",
            TOKENIZATION_REVISION,
            "Unsupported corpus tokenization revision.",
        )?;
        expect_meta(
            "normalization_revision",
            NORMALIZATION_REVISION,
            "Unsupported corpus normalization revision.",
        )?;
        expect_meta(
            "dictionary_revision",
            DICTIONARY_REVISION,
            "Unsupported corpus dictionary revision.",
        )?;
        expect_meta(
            "equivalence_revision",
            EQUIVALENCE_REVISION,
            "Unsupported corpus equivalence revision.",
        )?;
        Ok(())
    }

    pub fn counts(&self) -> Result<CorpusCounts, ClecError> {
        let count_of = |sql: &str| -> Result<usize, ClecError> {
            let n: i64 = self.conn.query_row(sql, [], |r| r.get(0)).map_err(|e| {
                ClecError::new(ErrorCode::InvalidPackage, format!("Count failed: {e}"))
            })?;
            usize::try_from(n)
                .map_err(|_| ClecError::new(ErrorCode::InvalidPackage, "Negative count"))
        };
        Ok(CorpusCounts {
            works: count_of("SELECT count(*) FROM works")?,
            sources: count_of("SELECT count(*) FROM sources")?,
            canonical_sources: count_of(
                "SELECT count(*) FROM source_canonical_map WHERE source_id = canonical_source_id",
            )?,
            blobs: count_of("SELECT count(*) FROM blobs")?,
            passages: count_of("SELECT count(*) FROM passages")?,
            cues: count_of("SELECT count(*) FROM cues")?,
            inventory: count_of("SELECT count(*) FROM inventory")?,
        })
    }

    pub fn diagnostics_summary(&self) -> Result<DiagnosticsSummary, ClecError> {
        let sources_with: i64 = self
            .conn
            .query_row(
                "SELECT count(DISTINCT source_id) FROM source_diagnostics",
                [],
                |r| r.get(0),
            )
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Diagnostics query failed: {e}"),
                )
            })?;
        let total: i64 = self
            .conn
            .query_row("SELECT count(*) FROM source_diagnostics", [], |r| r.get(0))
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Diagnostics query failed: {e}"),
                )
            })?;
        Ok(DiagnosticsSummary {
            sources_with_diagnostics: usize::try_from(sources_with).unwrap_or(0),
            total_diagnostics: usize::try_from(total).unwrap_or(0),
        })
    }

    fn validate_full(
        &self,
        work_dir: &Path,
        expected_counts: &CorpusCounts,
    ) -> Result<(), ClecError> {
        let actual_schema = collect_schema_rows(&self.conn)?;
        let expected_conn = Connection::open_in_memory().map_err(|e| {
            ClecError::new(
                ErrorCode::InternalError,
                format!("In-memory SQLite failed: {e}"),
            )
        })?;
        expected_conn.execute_batch(SCHEMA_SQL).map_err(|e| {
            ClecError::new(ErrorCode::InternalError, format!("Schema init failed: {e}"))
        })?;
        let expected_schema = collect_schema_rows(&expected_conn)?;
        if actual_schema != expected_schema {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Corpus SQLite schema does not match clec-native-v2.",
            ));
        }

        let integrity: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Integrity check failed: {e}"),
                )
            })?;
        if integrity != "ok" {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "SQLite PRAGMA integrity_check failed.",
            ));
        }

        self.verify_format_header()?;
        self.run_native_fts5_integrity_check()?;

        let actual_counts = self.counts()?;
        if &actual_counts != expected_counts {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Manifest counts do not match corpus database counts.",
            ));
        }

        let valid_blobs = self.validate_blobs()?;
        let work_ids = self.validate_works()?;
        let source_map = self.validate_sources(&work_ids, &valid_blobs)?;
        self.validate_sources_passages_and_fts(work_dir, &source_map, expected_counts)
    }

    fn run_native_fts5_integrity_check(&self) -> Result<(), ClecError> {
        self.conn
            .execute_batch("PRAGMA query_only=OFF; BEGIN;")
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Cannot start SQLite FTS5 integrity-check transaction: {e}"),
                )
            })?;
        let check_res = self
            .conn
            .execute("INSERT INTO search(search) VALUES('integrity-check')", []);
        let _ = self.conn.execute_batch("ROLLBACK; PRAGMA query_only=ON;");
        check_res.map_err(|e| {
            ClecError::new(
                ErrorCode::IntegrityMismatch,
                format!("SQLite FTS5 integrity-check failed: {e}"),
            )
        })?;
        Ok(())
    }

    fn validate_blobs(&self) -> Result<HashSet<String>, ClecError> {
        let mut valid_hashes: HashSet<String> = HashSet::new();
        let mut stmt = self
            .conn
            .prepare("SELECT content_hash, raw_bytes, byte_len FROM blobs")
            .map_err(map_sql_pkg)?;
        let mut rows = stmt.query([]).map_err(map_sql_pkg)?;
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            let hash: String = row.get(0).map_err(map_sql_pkg)?;
            let bytes: Vec<u8> = row.get(1).map_err(map_sql_pkg)?;
            let byte_len: i64 = row.get(2).map_err(map_sql_pkg)?;
            if bytes.is_empty()
                || usize::try_from(byte_len).ok() != Some(bytes.len())
                || sha256_hex(&bytes) != hash
            {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "Blob SHA-256 or byte length mismatch.",
                ));
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| {
                ClecError::new(ErrorCode::InvalidPackage, "Blob is not valid UTF-8.")
            })?;
            if text.trim().is_empty() || text.contains('\0') {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Blob contains empty or NUL content.",
                ));
            }
            valid_hashes.insert(hash);
        }
        Ok(valid_hashes)
    }

    fn validate_works(&self) -> Result<HashMap<String, WorkId>, ClecError> {
        let mut work_ids = HashMap::new();
        let mut stmt = self
            .conn
            .prepare("SELECT id, work_key, title FROM works")
            .map_err(map_sql_pkg)?;
        let mut rows = stmt.query([]).map_err(map_sql_pkg)?;
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            let id_str: String = row.get(0).map_err(map_sql_pkg)?;
            let key: String = row.get(1).map_err(map_sql_pkg)?;
            let title: String = row.get(2).map_err(map_sql_pkg)?;
            if title.trim().is_empty() {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Empty work title.",
                ));
            }
            let id = WorkId::parse(&id_str)?;
            if id != WorkId::from_work_key(&key)? {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "WorkId does not match work_key.",
                ));
            }
            work_ids.insert(id_str, id);
        }
        Ok(work_ids)
    }

    fn validate_sources(
        &self,
        work_ids: &HashMap<String, WorkId>,
        valid_blobs: &HashSet<String>,
    ) -> Result<HashMap<String, SourceRecord>, ClecError> {
        let mut source_map: HashMap<String, SourceRecord> = HashMap::new();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.work_id, s.path, s.title, s.role, s.attribution, s.quality, s.date, s.date_basis, s.origin, s.content_hash,
                        m.canonical_source_id, m.equivalence_hash, m.projection_kind, m.equivalence_basis
                 FROM sources s
                 LEFT JOIN source_canonical_map m ON m.source_id = s.id",
            )
            .map_err(map_sql_pkg)?;
        let mut rows = stmt.query([]).map_err(map_sql_pkg)?;
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            let id_str: String = row.get(0).map_err(map_sql_pkg)?;
            let work_id_str: String = row.get(1).map_err(map_sql_pkg)?;
            let path: String = row.get(2).map_err(map_sql_pkg)?;
            let title: String = row.get(3).map_err(map_sql_pkg)?;
            let role_str: String = row.get(4).map_err(map_sql_pkg)?;
            let attr_str: String = row.get(5).map_err(map_sql_pkg)?;
            let quality: String = row.get(6).map_err(map_sql_pkg)?;
            let date_str: Option<String> = row.get(7).map_err(map_sql_pkg)?;
            let date_basis: Option<String> = row.get(8).map_err(map_sql_pkg)?;
            let origin: Option<String> = row.get(9).map_err(map_sql_pkg)?;
            let content_hash: String = row.get(10).map_err(map_sql_pkg)?;
            let canon_str: Option<String> = row.get(11).map_err(map_sql_pkg)?;
            let equiv_hash: Option<String> = row.get(12).map_err(map_sql_pkg)?;
            let proj_kind_str: Option<String> = row.get(13).map_err(map_sql_pkg)?;
            let equiv_basis_str: Option<String> = row.get(14).map_err(map_sql_pkg)?;

            let work_id = WorkId::parse(&work_id_str)?;
            if !work_ids.contains_key(work_id.as_str()) {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Source references unknown work.",
                ));
            }
            let role = SourceRole::parse(&role_str)?;
            let attribution = Attribution::parse(&attr_str)?;
            let date = match date_str {
                Some(d) => {
                    if date_basis.as_deref().is_none_or(|b| b.trim().is_empty()) {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Source with date must include date_basis.",
                        ));
                    }
                    Some(DateYmd::parse(&d)?)
                }
                None => None,
            };
            if !valid_blobs.contains(&content_hash) {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Source references missing blob.",
                ));
            }
            let derived = SourceId::derive(
                &work_id,
                &path,
                role,
                attribution,
                &content_hash,
                date.as_ref(),
                date_basis.as_deref(),
            );
            let parsed = SourceId::parse(&id_str)?;
            if parsed != derived {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "SourceId does not match derived source identity.",
                ));
            }
            let canonical_source_id = SourceId::parse(canon_str.as_deref().ok_or_else(|| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Source is missing source_canonical_map row.",
                )
            })?)?;
            let equivalence_hash = equiv_hash.ok_or_else(|| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Source is missing equivalence_hash.",
                )
            })?;
            let projection_kind =
                ProjectionKind::parse(proj_kind_str.as_deref().ok_or_else(|| {
                    ClecError::new(
                        ErrorCode::InvalidPackage,
                        "Source is missing projection_kind.",
                    )
                })?)?;
            let equivalence_basis =
                EquivalenceBasis::parse(equiv_basis_str.as_deref().ok_or_else(|| {
                    ClecError::new(
                        ErrorCode::InvalidPackage,
                        "Source is missing equivalence_basis.",
                    )
                })?)?;

            source_map.insert(
                id_str,
                SourceRecord {
                    source_id: parsed,
                    work_id,
                    path,
                    title,
                    role,
                    attribution,
                    quality,
                    date,
                    date_basis,
                    origin,
                    content_hash,
                    canonical_source_id,
                    equivalence_basis,
                    projection_kind,
                    equivalence_hash,
                },
            );
        }

        let map_total: i64 = self
            .conn
            .query_row("SELECT count(*) FROM source_canonical_map", [], |r| {
                r.get(0)
            })
            .map_err(map_sql_pkg)?;
        if usize::try_from(map_total).ok() != Some(source_map.len()) {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Orphan rows in source_canonical_map.",
            ));
        }
        Ok(source_map)
    }

    fn validate_sources_passages_and_fts(
        &self,
        work_dir: &Path,
        source_map: &HashMap<String, SourceRecord>,
        expected_counts: &CorpusCounts,
    ) -> Result<(), ClecError> {
        let num_buckets = if expected_counts.passages <= 2000 {
            1usize
        } else {
            64usize
        };
        let mut expected_buckets = PostingBuckets::new(work_dir, "expected", num_buckets)?;
        let mut expected_docsize: HashMap<i64, (usize, usize)> =
            HashMap::with_capacity(expected_counts.passages);
        let mut term_doc_freq: HashMap<String, u32> = HashMap::new();

        struct GroupMemberMeta<'a> {
            source: &'a SourceRecord,
            is_subtitle: bool,
            has_cues: bool,
            diagnostics_count: usize,
        }
        let mut equiv_groups: HashMap<(&str, SourceRole, &str), Vec<GroupMemberMeta<'_>>> =
            HashMap::new();

        let mut stmt_blob = self
            .conn
            .prepare("SELECT raw_bytes FROM blobs WHERE content_hash = ?1")
            .map_err(map_sql_pkg)?;
        let mut stmt_cues = self
            .conn
            .prepare(
                "SELECT ordinal, original_identifier, raw_start_byte, raw_end_byte, text_start_byte, text_end_byte, start_ms, end_ms FROM cues WHERE source_id = ?1 ORDER BY ordinal",
            )
            .map_err(map_sql_pkg)?;
        let mut stmt_diags = self
            .conn
            .prepare("SELECT ordinal, message FROM source_diagnostics WHERE source_id = ?1 ORDER BY ordinal")
            .map_err(map_sql_pkg)?;
        let mut stmt_passages = self
            .conn
            .prepare(
                "SELECT rowid, id, work_id, ordinal, boundary, is_continuation, continued_from, continued_to, text FROM passages WHERE source_id = ?1 ORDER BY ordinal",
            )
            .map_err(map_sql_pkg)?;
        let mut stmt_spans = self
            .conn
            .prepare(
                "SELECT span_ordinal, start_byte, end_byte, cue_ordinal FROM passage_spans WHERE passage_id = ?1 ORDER BY span_ordinal",
            )
            .map_err(map_sql_pkg)?;
        let mut stmt_fts = self
            .conn
            .prepare("SELECT rowid FROM search WHERE rowid = ?1")
            .map_err(map_sql_pkg)?;

        let mut checked_cues = 0usize;
        let mut checked_diags = 0usize;
        let mut checked_passages = 0usize;
        let mut checked_spans = 0usize;
        let mut checked_canonical_sources = 0usize;

        for (source_id, source) in source_map {
            let raw_bytes: Vec<u8> = stmt_blob
                .query_row([source.content_hash.as_str()], |r| r.get(0))
                .map_err(map_sql_pkg)?;
            let is_sub = is_subtitle_path(&source.path);
            let expected_ext = extract_source(&raw_bytes, is_sub)?;
            if is_sub && expected_ext.cues.is_empty() {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Subtitle source has no usable cues.",
                ));
            }

            {
                let mut db_cues = Vec::new();
                let mut cue_rows = stmt_cues.query([source_id.as_str()]).map_err(map_sql_pkg)?;
                while let Some(row) = cue_rows.next().map_err(map_sql_pkg)? {
                    db_cues.push(SubtitleCue {
                        ordinal: usize::try_from(row.get::<_, i64>(0).map_err(map_sql_pkg)?)
                            .map_err(|_| bad_cue())?,
                        original_identifier: row.get(1).map_err(map_sql_pkg)?,
                        raw_start_byte: usize::try_from(row.get::<_, i64>(2).map_err(map_sql_pkg)?)
                            .map_err(|_| bad_cue())?,
                        raw_end_byte: usize::try_from(row.get::<_, i64>(3).map_err(map_sql_pkg)?)
                            .map_err(|_| bad_cue())?,
                        text_start_byte: usize::try_from(
                            row.get::<_, i64>(4).map_err(map_sql_pkg)?,
                        )
                        .map_err(|_| bad_cue())?,
                        text_end_byte: usize::try_from(row.get::<_, i64>(5).map_err(map_sql_pkg)?)
                            .map_err(|_| bad_cue())?,
                        start_ms: u64::try_from(row.get::<_, i64>(6).map_err(map_sql_pkg)?)
                            .map_err(|_| bad_cue())?,
                        end_ms: u64::try_from(row.get::<_, i64>(7).map_err(map_sql_pkg)?)
                            .map_err(|_| bad_cue())?,
                    });
                }
                if db_cues.as_slice() != expected_ext.cues.as_slice() {
                    return Err(bad_cue());
                }
                checked_cues += db_cues.len();
            }

            {
                let mut db_diags = Vec::new();
                let mut diag_rows = stmt_diags
                    .query([source_id.as_str()])
                    .map_err(map_sql_pkg)?;
                while let Some(row) = diag_rows.next().map_err(map_sql_pkg)? {
                    let ord = usize::try_from(row.get::<_, i64>(0).map_err(map_sql_pkg)?).map_err(
                        |_| {
                            ClecError::new(
                                ErrorCode::InvalidPackage,
                                "Negative diagnostic ordinal.",
                            )
                        },
                    )?;
                    if ord != db_diags.len() {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Non-sequential source diagnostic ordinal.",
                        ));
                    }
                    db_diags.push(row.get::<_, String>(1).map_err(map_sql_pkg)?);
                }
                if db_diags.as_slice() != expected_ext.diagnostics.as_slice() {
                    return Err(ClecError::new(
                        ErrorCode::InvalidPackage,
                        "Source diagnostics do not match canonical cue extraction.",
                    ));
                }
                checked_diags += db_diags.len();
            }

            let proj = compute_equivalence_projection(&expected_ext, &source.path)?;
            if source.equivalence_hash != proj.equivalence_hash
                || source.projection_kind != proj.kind
            {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "Source equivalence projection does not match canonical extraction.",
                ));
            }
            equiv_groups
                .entry((
                    source.work_id.as_str(),
                    source.role,
                    source.equivalence_hash.as_str(),
                ))
                .or_default()
                .push(GroupMemberMeta {
                    source,
                    is_subtitle: is_sub,
                    has_cues: !expected_ext.cues.is_empty(),
                    diagnostics_count: expected_ext.diagnostics.len(),
                });

            let is_canonical = source.canonical_source_id == source.source_id;
            let mut stored_passages = Vec::new();
            {
                let mut p_rows = stmt_passages
                    .query([source_id.as_str()])
                    .map_err(map_sql_pkg)?;
                while let Some(row) = p_rows.next().map_err(map_sql_pkg)? {
                    let rowid: i64 = row.get(0).map_err(map_sql_pkg)?;
                    let id_str: String = row.get(1).map_err(map_sql_pkg)?;
                    let work_id_str: String = row.get(2).map_err(map_sql_pkg)?;
                    let ordinal_i64: i64 = row.get(3).map_err(map_sql_pkg)?;
                    let boundary_str: String = row.get(4).map_err(map_sql_pkg)?;
                    let is_cont_i64: i64 = row.get(5).map_err(map_sql_pkg)?;
                    let cont_from: Option<String> = row.get(6).map_err(map_sql_pkg)?;
                    let cont_to: Option<String> = row.get(7).map_err(map_sql_pkg)?;
                    let text: String = row.get(8).map_err(map_sql_pkg)?;

                    if !is_canonical {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Non-canonical equivalent source must not have indexed passages.",
                        ));
                    }

                    let is_continuation = match is_cont_i64 {
                        0 => false,
                        1 => true,
                        _ => {
                            return Err(ClecError::new(
                                ErrorCode::InvalidPackage,
                                "Invalid is_continuation value in passages.",
                            ));
                        }
                    };
                    let continued_from = cont_from.as_deref().map(PassageId::parse).transpose()?;
                    let continued_to = cont_to.as_deref().map(PassageId::parse).transpose()?;

                    if work_id_str != source.work_id.as_str() {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Passage work_id disagrees with source work_id.",
                        ));
                    }
                    let ordinal = usize::try_from(ordinal_i64).map_err(|_| {
                        ClecError::new(ErrorCode::InvalidPackage, "Negative passage ordinal.")
                    })?;
                    if ordinal != stored_passages.len() {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Non-contiguous passage ordinals.",
                        ));
                    }

                    let boundary = BoundaryKind::parse(&boundary_str)?;
                    let mut spans = Vec::new();
                    {
                        let mut s_rows =
                            stmt_spans.query([id_str.as_str()]).map_err(map_sql_pkg)?;
                        while let Some(srow) = s_rows.next().map_err(map_sql_pkg)? {
                            let ord: i64 = srow.get(0).map_err(map_sql_pkg)?;
                            if usize::try_from(ord).ok() != Some(spans.len()) {
                                return Err(ClecError::new(
                                    ErrorCode::InvalidPackage,
                                    "Non-sequential passage span ordinal.",
                                ));
                            }
                            let start =
                                usize::try_from(srow.get::<_, i64>(1).map_err(map_sql_pkg)?)
                                    .map_err(|_| {
                                        ClecError::new(
                                            ErrorCode::InvalidPackage,
                                            "Negative span start.",
                                        )
                                    })?;
                            let end = usize::try_from(srow.get::<_, i64>(2).map_err(map_sql_pkg)?)
                                .map_err(|_| {
                                    ClecError::new(ErrorCode::InvalidPackage, "Negative span end.")
                                })?;
                            let cue_ord: Option<i64> = srow.get(3).map_err(map_sql_pkg)?;
                            let cue_ordinal = cue_ord
                                .map(|v| {
                                    usize::try_from(v).map_err(|_| {
                                        ClecError::new(
                                            ErrorCode::InvalidPackage,
                                            "Negative cue ordinal.",
                                        )
                                    })
                                })
                                .transpose()?;
                            spans.push(ByteSpan::new(start, end, cue_ordinal)?);
                        }
                    }
                    if spans.is_empty() {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Passage has zero source byte spans.",
                        ));
                    }
                    checked_spans += spans.len();

                    for span in &spans {
                        if expected_ext.is_subtitle {
                            let Some(cue_ord) = span.cue_ordinal() else {
                                return Err(ClecError::new(
                                    ErrorCode::InvalidPackage,
                                    "Subtitle passage span is missing cue_ordinal.",
                                ));
                            };
                            let Some(cue) = expected_ext.cues.get(cue_ord) else {
                                return Err(ClecError::new(
                                    ErrorCode::InvalidPackage,
                                    "Passage span references non-existent cue ordinal.",
                                ));
                            };
                            if span.start_byte() < cue.text_start_byte
                                || span.end_byte() > cue.text_end_byte
                            {
                                return Err(ClecError::new(
                                    ErrorCode::InvalidPackage,
                                    "Passage span lies outside its referenced cue payload.",
                                ));
                            }
                        } else if span.cue_ordinal().is_some() {
                            return Err(ClecError::new(
                                ErrorCode::InvalidPackage,
                                "Plain-text passage span must not carry cue_ordinal.",
                            ));
                        }
                    }

                    let reconstructed = reconstruct_passage_text(&raw_bytes, &spans)?;
                    if reconstructed != text {
                        return Err(ClecError::new(
                            ErrorCode::IntegrityMismatch,
                            "Passage text does not match source byte spans.",
                        ));
                    }
                    if text.chars().count() > 2000 {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Passage exceeds 2000 Unicode scalar cap.",
                        ));
                    }

                    let parsed_id = PassageId::parse(&id_str)?;
                    if parsed_id != PassageId::derive(&source.source_id, ordinal, &spans) {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "PassageId does not match derived provenance.",
                        ));
                    }

                    let has_fts: Option<i64> = stmt_fts.query_row([rowid], |r| r.get(0)).ok();
                    if has_fts.is_none() {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Passage is missing from FTS5 search table.",
                        ));
                    }

                    stored_passages.push((
                        rowid,
                        parsed_id,
                        boundary,
                        is_continuation,
                        continued_from,
                        continued_to,
                        spans,
                        text,
                    ));
                }
            }

            if !is_canonical {
                continue;
            }
            checked_canonical_sources += 1;
            if stored_passages.is_empty() {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Canonical source has zero passages.",
                ));
            }

            let expected_drafts = segment_source(&expected_ext, source.role)?;
            if stored_passages.len() != expected_drafts.len() {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Passage count does not match canonical segmentation.",
                ));
            }

            let title_tokens = index_tokens_string(&source.title);
            for (idx, (stored, draft)) in stored_passages
                .iter()
                .zip(expected_drafts.iter())
                .enumerate()
            {
                let (
                    rowid,
                    pid,
                    boundary,
                    is_continuation,
                    continued_from,
                    continued_to,
                    spans,
                    text,
                ) = stored;
                if *boundary != draft.boundary
                    || *is_continuation != draft.is_continuation
                    || *spans != draft.spans
                    || *text != draft.text
                {
                    return Err(ClecError::new(
                        ErrorCode::InvalidPackage,
                        "Passage segmentation or spans do not match canonical ingest.",
                    ));
                }
                if idx == 0 && (*is_continuation || continued_from.is_some()) {
                    return Err(ClecError::new(
                        ErrorCode::InvalidPackage,
                        "First passage cannot be a continuation.",
                    ));
                }
                if idx > 0 {
                    let prev_id = &stored_passages[idx - 1].1;
                    let prev_to = &stored_passages[idx - 1].5;
                    if *is_continuation {
                        if continued_from.as_ref() != Some(prev_id) || prev_to.as_ref() != Some(pid)
                        {
                            return Err(ClecError::new(
                                ErrorCode::InvalidPackage,
                                "Continuation links do not match adjacent passage IDs.",
                            ));
                        }
                    } else if continued_from.is_some() || prev_to.is_some() {
                        return Err(ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Unexpected continuation link on non-continuation boundary.",
                        ));
                    }
                }
                if idx + 1 == stored_passages.len() && continued_to.is_some() {
                    return Err(ClecError::new(
                        ErrorCode::InvalidPackage,
                        "Last passage cannot carry continued_to.",
                    ));
                }

                let mut seen_terms: HashSet<&str> = HashSet::new();
                let mut title_count = 0usize;
                for (offset, tok) in title_tokens.split_ascii_whitespace().enumerate() {
                    expected_buckets.push(*rowid, 0, offset as u32, tok.as_bytes())?;
                    seen_terms.insert(tok);
                    title_count += 1;
                }
                let body_tokens = index_tokens_string(text);
                let mut body_count = 0usize;
                for (offset, tok) in body_tokens.split_ascii_whitespace().enumerate() {
                    expected_buckets.push(*rowid, 1, offset as u32, tok.as_bytes())?;
                    seen_terms.insert(tok);
                    body_count += 1;
                }
                for tok in seen_terms {
                    if let Some(cnt) = term_doc_freq.get_mut(tok) {
                        *cnt = cnt.saturating_add(1);
                    } else {
                        term_doc_freq.insert(tok.to_owned(), 1);
                    }
                }
                expected_docsize.insert(*rowid, (title_count, body_count));
                checked_passages += 1;
            }
        }

        if checked_canonical_sources != expected_counts.canonical_sources {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Canonical source count mismatch.",
            ));
        }

        for members in equiv_groups.values() {
            let candidates: Vec<CanonicalCandidate<'_>> = members
                .iter()
                .map(|m| CanonicalCandidate {
                    source_id: &m.source.source_id,
                    path: &m.source.path,
                    attribution: m.source.attribution,
                    is_subtitle: m.is_subtitle,
                    has_cues: m.has_cues,
                    diagnostics_count: m.diagnostics_count,
                })
                .collect();
            let winner_idx = select_canonical_index(&candidates).ok_or_else(|| {
                ClecError::new(ErrorCode::InvalidPackage, "Empty equivalence group.")
            })?;
            let winner_id = &members[winner_idx].source.source_id;
            for (idx, m) in members.iter().enumerate() {
                if &m.source.canonical_source_id != winner_id {
                    return Err(ClecError::new(
                        ErrorCode::InvalidPackage,
                        "Canonical representative selection disagrees with deterministic policy.",
                    ));
                }
                let expected_basis = if members.len() == 1 {
                    EquivalenceBasis::UniqueInWorkRole
                } else if idx == winner_idx {
                    EquivalenceBasis::CanonicalByTimingAndFormat
                } else {
                    EquivalenceBasis::CollapsedToCanonical
                };
                if m.source.equivalence_basis != expected_basis {
                    return Err(ClecError::new(
                        ErrorCode::InvalidPackage,
                        "Equivalence basis disagrees with canonical membership.",
                    ));
                }
            }
        }

        let check_total = |sql: &str, expected: usize, msg: &str| -> Result<(), ClecError> {
            let actual: i64 = self
                .conn
                .query_row(sql, [], |r| r.get(0))
                .map_err(map_sql_pkg)?;
            if usize::try_from(actual).ok() != Some(expected) {
                return Err(ClecError::new(ErrorCode::InvalidPackage, msg));
            }
            Ok(())
        };
        check_total(
            "SELECT count(*) FROM cues",
            checked_cues,
            "Orphan cues detected.",
        )?;
        check_total(
            "SELECT count(*) FROM source_diagnostics",
            checked_diags,
            "Orphan source diagnostics detected.",
        )?;
        check_total(
            "SELECT count(*) FROM passages",
            checked_passages,
            "Orphan passages detected.",
        )?;
        check_total(
            "SELECT count(*) FROM passage_spans",
            checked_spans,
            "Orphan passage spans detected.",
        )?;
        check_total(
            "SELECT count(*) FROM search",
            expected_docsize.len(),
            "Orphan FTS5 search rows detected.",
        )?;

        expected_buckets.flush()?;
        self.validate_fts_postings_streaming(
            work_dir,
            &mut expected_buckets,
            &expected_docsize,
            &term_doc_freq,
        )
    }

    fn validate_fts_postings_streaming(
        &self,
        work_dir: &Path,
        expected_buckets: &mut PostingBuckets,
        expected_docsize: &HashMap<i64, (usize, usize)>,
        term_doc_freq: &HashMap<String, u32>,
    ) -> Result<(), ClecError> {
        let num_buckets = expected_buckets.num_buckets();
        let mut actual_buckets = PostingBuckets::new(work_dir, "actual", num_buckets)?;

        self.conn
            .execute_batch(
                "PRAGMA query_only=OFF;
                 DROP TABLE IF EXISTS temp.__clec_fts_vocab;
                 CREATE VIRTUAL TABLE temp.__clec_fts_vocab USING fts5vocab(main, search, instance);",
            )
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::InvalidPackage,
                    format!("Cannot inspect FTS5 postings: {e}"),
                )
            })?;

        let vocab_res = (|| -> Result<(), ClecError> {
            {
                let mut stmt = self
                    .conn
                    .prepare("SELECT doc, col, offset, term FROM temp.__clec_fts_vocab")
                    .map_err(map_sql_pkg)?;
                let mut rows = stmt.query([]).map_err(map_sql_pkg)?;
                while let Some(row) = rows.next().map_err(map_sql_pkg)? {
                    let doc: i64 = row.get(0).map_err(map_sql_pkg)?;
                    let col: String = row.get(1).map_err(map_sql_pkg)?;
                    let offset_i64: i64 = row.get(2).map_err(map_sql_pkg)?;
                    let term: String = row.get(3).map_err(map_sql_pkg)?;
                    if !expected_docsize.contains_key(&doc) {
                        return Err(ClecError::new(
                            ErrorCode::IntegrityMismatch,
                            "FTS5 posting references unknown passage rowid.",
                        ));
                    }
                    let col_id = match col.as_str() {
                        "title_tokens" => 0u8,
                        "body_tokens" => 1u8,
                        _ => {
                            return Err(ClecError::new(
                                ErrorCode::InvalidPackage,
                                "Unknown FTS5 column in postings.",
                            ));
                        }
                    };
                    let offset = u32::try_from(offset_i64).map_err(|_| {
                        ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Negative or oversized FTS5 token offset.",
                        )
                    })?;
                    actual_buckets.push(doc, col_id, offset, term.as_bytes())?;
                }
            }
            actual_buckets.flush()?;

            let mut docsize_rows = 0usize;
            {
                let mut stmt = self
                    .conn
                    .prepare("SELECT id, sz FROM search_docsize")
                    .map_err(map_sql_pkg)?;
                let mut rows = stmt.query([]).map_err(map_sql_pkg)?;
                while let Some(row) = rows.next().map_err(map_sql_pkg)? {
                    let doc: i64 = row.get(0).map_err(map_sql_pkg)?;
                    let sz: Vec<u8> = row.get(1).map_err(map_sql_pkg)?;
                    let (t_len, b_len) = decode_fts5_docsize(&sz).ok_or_else(|| {
                        ClecError::new(
                            ErrorCode::InvalidPackage,
                            "Malformed FTS5 search_docsize record.",
                        )
                    })?;
                    if expected_docsize.get(&doc) != Some(&(t_len, b_len)) {
                        return Err(ClecError::new(
                            ErrorCode::IntegrityMismatch,
                            "FTS5 document token counts do not match source-derived tokens.",
                        ));
                    }
                    docsize_rows += 1;
                }
            }
            if docsize_rows != expected_docsize.len() {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "FTS5 search_docsize row count mismatch.",
                ));
            }
            Ok(())
        })();

        let _ = self
            .conn
            .execute_batch("DROP TABLE IF EXISTS temp.__clec_fts_vocab; PRAGMA query_only=ON;");
        vocab_res?;

        let probe_tok = term_doc_freq
            .iter()
            .min_by(|(t1, c1), (t2, c2)| c1.cmp(c2).then_with(|| t1.cmp(t2)))
            .map(|(t, _)| t.as_str());
        let probe_bytes = probe_tok.map(str::as_bytes);
        let mut doc_weights: BTreeMap<i64, f64> = BTreeMap::new();

        for b in 0..num_buckets {
            let exp = expected_buckets.take_sorted(b)?;
            let act = actual_buckets.take_sorted(b)?;
            if !postings_equal(&exp, &act) {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "FTS5 search postings do not match source-derived normalized title/body tokens.",
                ));
            }
            if let Some(target) = probe_bytes {
                for entry in &exp.entries {
                    let term = &exp.arena[entry.term_off as usize
                        ..entry.term_off as usize + entry.term_len as usize];
                    if term == target {
                        let weight = if entry.col == 0 { 4.0 } else { 1.0 };
                        *doc_weights.entry(entry.rowid).or_insert(0.0) += weight;
                    }
                }
            }
        }

        if let Some(tok) = probe_tok {
            self.validate_fts_bm25_probe(tok, &doc_weights, expected_docsize)?;
        }
        Ok(())
    }

    fn validate_fts_bm25_probe(
        &self,
        probe_tok: &str,
        doc_weights: &BTreeMap<i64, f64>,
        expected_docsize: &HashMap<i64, (usize, usize)>,
    ) -> Result<(), ClecError> {
        let total_tokens: usize = expected_docsize.values().map(|(t, b)| t + b).sum();
        if doc_weights.is_empty() || expected_docsize.is_empty() || total_tokens == 0 {
            return Ok(());
        }

        let n_row = expected_docsize.len() as f64;
        let n_hit = doc_weights.len() as f64;
        let avgdl = (total_tokens as f64) / n_row;
        let idf_raw = ((n_row - n_hit + 0.5) / (n_hit + 0.5)).ln();
        let idf = if idf_raw.is_finite() && idf_raw > 0.0 {
            idf_raw
        } else {
            1e-6
        };

        let mut stmt = self
            .conn
            .prepare(
                "SELECT rowid, bm25(search, 4.0, 1.0) FROM search WHERE search MATCH ?1 ORDER BY rowid",
            )
            .map_err(|e| {
                ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    format!("FTS5 BM25 health check prepare failed: {e}"),
                )
            })?;
        let mut rows = stmt.query([probe_tok]).map_err(|e| {
            ClecError::new(
                ErrorCode::IntegrityMismatch,
                format!("FTS5 BM25 health check query failed: {e}"),
            )
        })?;

        let mut actual_scores: BTreeMap<i64, f64> = BTreeMap::new();
        loop {
            let row = rows.next().map_err(|e| {
                ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    format!("FTS5 BM25 health check failed: {e}"),
                )
            })?;
            let Some(row) = row else {
                break;
            };
            let rowid: i64 = row.get(0).map_err(|e| {
                ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    format!("FTS5 BM25 health check rowid error: {e}"),
                )
            })?;
            let score_opt: Option<f64> = row.get(1).map_err(|e| {
                ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    format!("FTS5 BM25 health check score error: {e}"),
                )
            })?;
            let score = score_opt.ok_or_else(|| {
                ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "FTS5 BM25 health check returned NULL/NaN score (corrupt FTS5 global statistics).",
                )
            })?;
            actual_scores.insert(rowid, score);
        }

        if actual_scores.len() != doc_weights.len() {
            return Err(ClecError::new(
                ErrorCode::IntegrityMismatch,
                "FTS5 BM25 health check row count mismatch.",
            ));
        }

        for (&rowid, &freq) in doc_weights {
            let Some(&actual) = actual_scores.get(&rowid) else {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "FTS5 BM25 health check missing expected rowid.",
                ));
            };
            let (t_len, b_len) = expected_docsize[&rowid];
            let doc_len = (t_len + b_len) as f64;
            let expected = -idf * (freq * 2.2) / (freq + 1.2 * (0.25 + 0.75 * doc_len / avgdl));
            if !actual.is_finite() || (actual - expected).abs() > 1e-9 {
                return Err(ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "FTS5 BM25 score mismatch indicates corrupt FTS5 global statistics.",
                ));
            }
        }
        Ok(())
    }

    pub fn load_work(&self, work_id: &WorkId) -> Result<WorkRecord, ClecError> {
        self.conn
            .query_row(
                "SELECT id, work_key, title FROM works WHERE id=?",
                [work_id.as_str()],
                |row| {
                    let id_s: String = row.get(0)?;
                    let work_key: String = row.get(1)?;
                    let title: String = row.get(2)?;
                    Ok((id_s, work_key, title))
                },
            )
            .map_err(|_| ClecError::new(ErrorCode::EvidenceNotFound, "Work not found."))
            .and_then(|(id_s, work_key, title)| {
                Ok(WorkRecord {
                    work_id: WorkId::parse(&id_s)?,
                    work_key,
                    title,
                })
            })
    }

    pub fn load_source(&self, source_id: &SourceId) -> Result<SourceRecord, ClecError> {
        let row = self
            .conn
            .query_row(
                "SELECT s.id, s.work_id, s.path, s.title, s.role, s.attribution, s.quality, s.date, s.date_basis, s.origin, s.content_hash,
                        m.canonical_source_id, m.equivalence_basis, m.projection_kind, m.equivalence_hash
                 FROM sources s
                 JOIN source_canonical_map m ON m.source_id = s.id
                 WHERE s.id=?",
                [source_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                        row.get::<_, String>(14)?,
                    ))
                },
            )
            .map_err(|_| ClecError::new(ErrorCode::EvidenceNotFound, format!("Source {} not found.", source_id)))?;

        Ok(SourceRecord {
            source_id: SourceId::parse(&row.0)?,
            work_id: WorkId::parse(&row.1)?,
            path: row.2,
            title: row.3,
            role: SourceRole::parse(&row.4)?,
            attribution: Attribution::parse(&row.5)?,
            quality: row.6,
            date: row.7.map(|d| DateYmd::parse(&d)).transpose()?,
            date_basis: row.8,
            origin: row.9,
            content_hash: row.10,
            canonical_source_id: SourceId::parse(&row.11)?,
            equivalence_basis: EquivalenceBasis::parse(&row.12)?,
            projection_kind: ProjectionKind::parse(&row.13)?,
            equivalence_hash: row.14,
        })
    }

    pub fn load_equivalent_sources(
        &self,
        canonical_source_id: &SourceId,
    ) -> Result<Vec<EquivalentSourceRef>, ClecError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.path, s.role, s.attribution, m.projection_kind, m.equivalence_basis, m.canonical_source_id
                 FROM source_canonical_map m
                 JOIN sources s ON s.id = m.source_id
                 WHERE m.canonical_source_id = ?
                 ORDER BY s.path, s.id",
            )
            .map_err(map_sql_pkg)?;
        let mut rows = stmt
            .query([canonical_source_id.as_str()])
            .map_err(map_sql_pkg)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            let sid = SourceId::parse(&row.get::<_, String>(0).map_err(map_sql_pkg)?)?;
            let path: String = row.get(1).map_err(map_sql_pkg)?;
            let role = SourceRole::parse(&row.get::<_, String>(2).map_err(map_sql_pkg)?)?;
            let attribution = Attribution::parse(&row.get::<_, String>(3).map_err(map_sql_pkg)?)?;
            let projection_kind =
                ProjectionKind::parse(&row.get::<_, String>(4).map_err(map_sql_pkg)?)?;
            let equivalence_basis =
                EquivalenceBasis::parse(&row.get::<_, String>(5).map_err(map_sql_pkg)?)?;
            let canon = SourceId::parse(&row.get::<_, String>(6).map_err(map_sql_pkg)?)?;
            out.push(EquivalentSourceRef {
                is_canonical: sid == canon,
                source_id: sid,
                path,
                role,
                attribution,
                projection_kind,
                equivalence_basis,
            });
        }
        Ok(out)
    }

    pub fn load_verified_blob(&self, content_hash: &str) -> Result<Vec<u8>, ClecError> {
        let raw_bytes: Vec<u8> = self
            .conn
            .query_row(
                "SELECT raw_bytes FROM blobs WHERE content_hash=?",
                [content_hash],
                |r| r.get(0),
            )
            .map_err(|_| {
                ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "Missing source blob for provenance check.",
                )
            })?;
        if sha256_hex(&raw_bytes) != content_hash {
            return Err(ClecError::new(
                ErrorCode::IntegrityMismatch,
                "Local source bytes fail SHA-256 provenance verification.",
            ));
        }
        Ok(raw_bytes)
    }

    pub fn load_spans(&self, passage_id: &str) -> Result<Vec<ByteSpan>, ClecError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT span_ordinal, start_byte, end_byte, cue_ordinal FROM passage_spans WHERE passage_id=? ORDER BY span_ordinal",
            )
            .map_err(map_sql_pkg)?;
        let mut rows = stmt.query([passage_id]).map_err(map_sql_pkg)?;
        let mut spans = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            let ord: i64 = row.get(0).map_err(map_sql_pkg)?;
            if usize::try_from(ord).ok() != Some(spans.len()) {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Non-sequential passage span ordinal.",
                ));
            }
            let start: usize = usize::try_from(row.get::<_, i64>(1).map_err(map_sql_pkg)?)
                .map_err(|_| ClecError::new(ErrorCode::InvalidPackage, "Negative span start."))?;
            let end: usize = usize::try_from(row.get::<_, i64>(2).map_err(map_sql_pkg)?)
                .map_err(|_| ClecError::new(ErrorCode::InvalidPackage, "Negative span end."))?;
            let cue_ord: Option<i64> = row.get(3).map_err(map_sql_pkg)?;
            let cue_ordinal = cue_ord
                .map(|v| {
                    usize::try_from(v).map_err(|_| {
                        ClecError::new(ErrorCode::InvalidPackage, "Negative cue ordinal.")
                    })
                })
                .transpose()?;
            spans.push(ByteSpan::new(start, end, cue_ordinal)?);
        }
        if spans.is_empty() {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Passage has zero source byte spans.",
            ));
        }
        Ok(spans)
    }

    pub fn load_diagnostics(&self, source_id: &SourceId) -> Result<Vec<String>, ClecError> {
        let mut stmt = self
            .conn
            .prepare("SELECT message FROM source_diagnostics WHERE source_id=? ORDER BY ordinal")
            .map_err(map_sql_pkg)?;
        let mut rows = stmt.query([source_id.as_str()]).map_err(map_sql_pkg)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            out.push(row.get(0).map_err(map_sql_pkg)?);
        }
        Ok(out)
    }

    pub fn load_cues_for_spans(
        &self,
        source_id: &SourceId,
        spans: &[ByteSpan],
    ) -> Result<Vec<SubtitleCue>, ClecError> {
        let cue_ordinals: Vec<usize> = spans.iter().filter_map(ByteSpan::cue_ordinal).collect();
        if cue_ordinals.is_empty() {
            return Ok(Vec::new());
        }
        let min_ord = *cue_ordinals.iter().min().unwrap();
        let max_ord = *cue_ordinals.iter().max().unwrap();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ordinal, original_identifier, raw_start_byte, raw_end_byte, text_start_byte, text_end_byte, start_ms, end_ms FROM cues WHERE source_id=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal",
            )
            .map_err(map_sql_pkg)?;
        let mut rows = stmt
            .query(params![
                source_id.as_str(),
                i64::try_from(min_ord).unwrap_or(0),
                i64::try_from(max_ord).unwrap_or(i64::MAX),
            ])
            .map_err(map_sql_pkg)?;
        let mut cues = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            cues.push(SubtitleCue {
                ordinal: usize::try_from(row.get::<_, i64>(0).map_err(map_sql_pkg)?).unwrap_or(0),
                original_identifier: row.get(1).map_err(map_sql_pkg)?,
                raw_start_byte: usize::try_from(row.get::<_, i64>(2).map_err(map_sql_pkg)?)
                    .unwrap_or(0),
                raw_end_byte: usize::try_from(row.get::<_, i64>(3).map_err(map_sql_pkg)?)
                    .unwrap_or(0),
                text_start_byte: usize::try_from(row.get::<_, i64>(4).map_err(map_sql_pkg)?)
                    .unwrap_or(0),
                text_end_byte: usize::try_from(row.get::<_, i64>(5).map_err(map_sql_pkg)?)
                    .unwrap_or(0),
                start_ms: u64::try_from(row.get::<_, i64>(6).map_err(map_sql_pkg)?).unwrap_or(0),
                end_ms: u64::try_from(row.get::<_, i64>(7).map_err(map_sql_pkg)?).unwrap_or(0),
            });
        }
        Ok(cues)
    }

    pub fn load_verified_passage_core(
        &self,
        passage_id: &PassageId,
    ) -> Result<VerifiedPassageCore, ClecError> {
        let row = self
            .conn
            .query_row(
                "SELECT source_id, ordinal, boundary, is_continuation, continued_from, continued_to, text FROM passages WHERE id=?",
                [passage_id.as_str()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                },
            )
            .map_err(|_| {
                ClecError::new(
                    ErrorCode::EvidenceNotFound,
                    format!("Passage {} not found.", passage_id),
                )
            })?;

        let source_id = SourceId::parse(&row.0)?;
        let source = self.load_source(&source_id)?;
        let work = self.load_work(&source.work_id)?;
        let raw_bytes = self.load_verified_blob(&source.content_hash)?;
        let spans = self.load_spans(passage_id.as_str())?;
        let reconstructed = reconstruct_passage_text(&raw_bytes, &spans)?;
        if reconstructed != row.6 {
            return Err(ClecError::new(
                ErrorCode::IntegrityMismatch,
                format!(
                    "Passage {} text does not match its raw source byte spans.",
                    passage_id
                ),
            ));
        }
        let cues = self.load_cues_for_spans(&source_id, &spans)?;
        let ordinal = usize::try_from(row.1)
            .map_err(|_| ClecError::new(ErrorCode::InvalidPackage, "Negative passage ordinal."))?;
        let boundary = BoundaryKind::parse(&row.2)?;
        let continued_from = row.4.map(|s| PassageId::parse(&s)).transpose()?;
        let continued_to = row.5.map(|s| PassageId::parse(&s)).transpose()?;

        let ctx = PassageContext {
            passage_id: passage_id.clone(),
            ordinal,
            boundary,
            is_continuation: row.3 != 0,
            spans,
            cues,
            text: row.6,
        };
        Ok(VerifiedPassageCore {
            context: ctx,
            source,
            work,
            continued_from,
            continued_to,
        })
    }

    pub fn adjacent_passage_id(
        &self,
        source_id: &SourceId,
        ordinal: isize,
    ) -> Result<Option<PassageId>, ClecError> {
        if ordinal < 0 {
            return Ok(None);
        }
        let found: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM passages WHERE source_id=? AND ordinal=?",
                params![source_id.as_str(), ordinal as i64],
                |r| r.get(0),
            )
            .ok();
        found.map(|s| PassageId::parse(&s)).transpose()
    }

    pub fn read_passage(
        &self,
        passage_id: &PassageId,
        context_sides: usize,
        find_literal: Option<&str>,
    ) -> Result<PassageReadItem, ClecError> {
        let verified = self.load_verified_passage_core(passage_id)?;
        let core = verified.context;
        let source = verified.source;
        let work = verified.work;
        let continued_from = verified.continued_from;
        let continued_to = verified.continued_to;
        let diagnostics = self.load_diagnostics(&source.source_id)?;
        let previous = self.adjacent_passage_id(
            &source.source_id,
            isize::try_from(core.ordinal).unwrap_or(0) - 1,
        )?;
        let next = self.adjacent_passage_id(
            &source.source_id,
            isize::try_from(core.ordinal).unwrap_or(0) + 1,
        )?;

        let mut context = Vec::new();
        if context_sides > 0 {
            let min_ord = core.ordinal.saturating_sub(context_sides);
            let max_ord = core.ordinal.saturating_add(context_sides);
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT id FROM passages WHERE source_id=? AND ordinal BETWEEN ? AND ? AND ordinal != ? ORDER BY ordinal",
                )
                .map_err(map_sql_pkg)?;
            let mut rows = stmt
                .query(params![
                    source.source_id.as_str(),
                    min_ord as i64,
                    max_ord as i64,
                    core.ordinal as i64
                ])
                .map_err(map_sql_pkg)?;
            while let Some(row) = rows.next().map_err(map_sql_pkg)? {
                let adj_id = PassageId::parse(&row.get::<_, String>(0).map_err(map_sql_pkg)?)?;
                let adj = self.load_verified_passage_core(&adj_id)?;
                context.push(adj.context);
            }
        }

        let literal_matches = find_literal.map(|needle| {
            find_literal_in_text(&core.text, needle, std::slice::from_ref(passage_id))
        });

        Ok(PassageReadItem {
            passage_id: core.passage_id,
            work,
            source,
            ordinal: core.ordinal,
            boundary: core.boundary,
            is_continuation: core.is_continuation,
            continued_from,
            continued_to,
            previous,
            next,
            spans: core.spans,
            cues: core.cues,
            diagnostics,
            text: core.text,
            context,
            literal_matches,
        })
    }

    pub fn read_source_original(
        &self,
        source_id: &SourceId,
        find_literal: Option<&str>,
    ) -> Result<SourceOriginalItem, ClecError> {
        let source = self.load_source(source_id)?;
        let work = self.load_work(&source.work_id)?;
        let equivalent_sources = self.load_equivalent_sources(&source.canonical_source_id)?;
        let raw_bytes = self.load_verified_blob(&source.content_hash)?;
        let original_text = String::from_utf8(raw_bytes).map_err(|_| {
            ClecError::new(
                ErrorCode::IntegrityMismatch,
                "Stored source bytes are not valid UTF-8.",
            )
        })?;
        let diagnostics = self.load_diagnostics(&source.source_id)?;
        let passage_ids = self.list_source_passage_ids(&source.source_id)?;

        let literal_matches = if let Some(needle) = find_literal {
            Some(self.find_literal_in_source(&source.source_id, &original_text, needle)?)
        } else {
            None
        };

        let byte_len = original_text.len();
        Ok(SourceOriginalItem {
            work,
            source,
            equivalent_sources,
            diagnostics,
            passage_ids,
            byte_len,
            original_text,
            literal_matches,
        })
    }

    pub fn read_source_overview(
        &self,
        source_id: &SourceId,
    ) -> Result<SourceOverviewItem, ClecError> {
        let source = self.load_source(source_id)?;
        let work = self.load_work(&source.work_id)?;
        let equivalent_sources = self.load_equivalent_sources(&source.canonical_source_id)?;
        let diagnostics = self.load_diagnostics(&source.source_id)?;
        let passage_ids = self.list_source_passage_ids(&source.source_id)?;
        let canonical_passage_ids = if source.canonical_source_id == source.source_id {
            passage_ids.clone()
        } else {
            self.list_source_passage_ids(&source.canonical_source_id)?
        };
        let cue_count_i64: i64 = self
            .conn
            .query_row(
                "SELECT count(*) FROM cues WHERE source_id=?",
                [source.source_id.as_str()],
                |r| r.get(0),
            )
            .map_err(map_sql_pkg)?;
        Ok(SourceOverviewItem {
            work,
            source,
            equivalent_sources,
            passage_count: passage_ids.len(),
            cue_count: usize::try_from(cue_count_i64).unwrap_or(0),
            diagnostics,
            passage_ids,
            canonical_passage_ids,
        })
    }

    fn list_source_passage_ids(&self, source_id: &SourceId) -> Result<Vec<PassageId>, ClecError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM passages WHERE source_id=? ORDER BY ordinal")
            .map_err(map_sql_pkg)?;
        let mut rows = stmt.query([source_id.as_str()]).map_err(map_sql_pkg)?;
        let mut ids = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            ids.push(PassageId::parse(
                &row.get::<_, String>(0).map_err(map_sql_pkg)?,
            )?);
        }
        Ok(ids)
    }

    fn find_literal_in_source(
        &self,
        source_id: &SourceId,
        original_text: &str,
        needle: &str,
    ) -> Result<Vec<FindMatch>, ClecError> {
        if needle.is_empty() || needle.len() > 512 || needle.contains('\0') {
            return Err(ClecError::new(
                ErrorCode::InvalidQuery,
                "Literal --find needle must be 1..512 UTF-8 bytes without NUL.",
            ));
        }

        let mut span_rows = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT p.id, ps.start_byte, ps.end_byte FROM passage_spans ps JOIN passages p ON p.id=ps.passage_id WHERE p.source_id=? ORDER BY p.ordinal, ps.span_ordinal",
                )
                .map_err(map_sql_pkg)?;
            let mut rows = stmt.query([source_id.as_str()]).map_err(map_sql_pkg)?;
            while let Some(row) = rows.next().map_err(map_sql_pkg)? {
                let pid = PassageId::parse(&row.get::<_, String>(0).map_err(map_sql_pkg)?)?;
                let start =
                    usize::try_from(row.get::<_, i64>(1).map_err(map_sql_pkg)?).unwrap_or(0);
                let end = usize::try_from(row.get::<_, i64>(2).map_err(map_sql_pkg)?).unwrap_or(0);
                span_rows.push((pid, start, end));
            }
        }

        let mut matches = Vec::new();
        let mut search_from = 0usize;
        while let Some(rel) = original_text[search_from..].find(needle) {
            let start_byte = search_from + rel;
            let end_byte = start_byte + needle.len();
            let mut overlapping = Vec::new();
            for (pid, ps_start, ps_end) in &span_rows {
                if *ps_end > start_byte && *ps_start < end_byte && !overlapping.contains(pid) {
                    overlapping.push(pid.clone());
                }
            }
            matches.push(FindMatch {
                start_byte,
                end_byte,
                passage_ids: overlapping,
            });
            let step = original_text[start_byte..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
            search_from = start_byte + step;
        }
        Ok(matches)
    }

    pub fn list_sources(
        &self,
        query: Option<&str>,
        work_filter: Option<&WorkId>,
        role_filter: Option<SourceRole>,
        canonical_only: bool,
    ) -> Result<Vec<SourceListEntry>, ClecError> {
        let normalized_terms: Vec<String> = match query {
            Some(q) if !q.trim().is_empty() => {
                if q.len() > 512 || q.contains('\0') {
                    return Err(ClecError::new(
                        ErrorCode::InvalidQuery,
                        "Sources query must be at most 512 UTF-8 bytes without NUL.",
                    ));
                }
                normalize_for_search(q)
                    .split_whitespace()
                    .map(ToOwned::to_owned)
                    .collect()
            }
            _ => Vec::new(),
        };

        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.id, s.work_id, w.work_key, w.title, s.path, s.title, s.role, s.attribution, s.quality, s.date, s.date_basis, s.content_hash,
                 m.canonical_source_id, m.equivalence_basis,
                 (SELECT count(*) FROM source_canonical_map m2 WHERE m2.canonical_source_id = m.canonical_source_id),
                 (SELECT count(*) FROM passages p WHERE p.source_id = s.id),
                 (SELECT count(*) FROM source_diagnostics d WHERE d.source_id = s.id)
                 FROM sources s
                 JOIN works w ON w.id = s.work_id
                 JOIN source_canonical_map m ON m.source_id = s.id
                 ORDER BY w.work_key, s.path, s.id",
            )
            .map_err(map_sql_pkg)?;

        let mut rows = stmt.query([]).map_err(map_sql_pkg)?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next().map_err(map_sql_pkg)? {
            let source_id = SourceId::parse(&row.get::<_, String>(0).map_err(map_sql_pkg)?)?;
            let work_id = WorkId::parse(&row.get::<_, String>(1).map_err(map_sql_pkg)?)?;
            let work_key: String = row.get(2).map_err(map_sql_pkg)?;
            let work_title: String = row.get(3).map_err(map_sql_pkg)?;
            let path: String = row.get(4).map_err(map_sql_pkg)?;
            let title: String = row.get(5).map_err(map_sql_pkg)?;
            let role = SourceRole::parse(&row.get::<_, String>(6).map_err(map_sql_pkg)?)?;
            let attribution = Attribution::parse(&row.get::<_, String>(7).map_err(map_sql_pkg)?)?;
            let quality: String = row.get(8).map_err(map_sql_pkg)?;
            let date = row
                .get::<_, Option<String>>(9)
                .map_err(map_sql_pkg)?
                .map(|d| DateYmd::parse(&d))
                .transpose()?;
            let date_basis: Option<String> = row.get(10).map_err(map_sql_pkg)?;
            let content_hash: String = row.get(11).map_err(map_sql_pkg)?;
            let canonical_source_id =
                SourceId::parse(&row.get::<_, String>(12).map_err(map_sql_pkg)?)?;
            let equivalence_basis =
                EquivalenceBasis::parse(&row.get::<_, String>(13).map_err(map_sql_pkg)?)?;
            let equivalent_count =
                usize::try_from(row.get::<_, i64>(14).map_err(map_sql_pkg)?).unwrap_or(1);
            let passage_count =
                usize::try_from(row.get::<_, i64>(15).map_err(map_sql_pkg)?).unwrap_or(0);
            let diagnostics_count =
                usize::try_from(row.get::<_, i64>(16).map_err(map_sql_pkg)?).unwrap_or(0);
            let is_canonical = source_id == canonical_source_id;

            if canonical_only && !is_canonical {
                continue;
            }
            if work_filter.is_some_and(|w| w != &work_id) {
                continue;
            }
            if role_filter.is_some_and(|r| r != role) {
                continue;
            }
            if !normalized_terms.is_empty() {
                let haystack =
                    normalize_for_search(&format!("{work_title}\n{work_key}\n{title}\n{path}"));
                if !normalized_terms.iter().all(|t| haystack.contains(t)) {
                    continue;
                }
            }

            entries.push(SourceListEntry {
                work_id,
                work_key,
                work_title,
                source_id,
                path,
                title,
                role,
                attribution,
                quality,
                date,
                date_basis,
                content_hash,
                canonical_source_id,
                is_canonical,
                equivalence_basis,
                equivalent_count,
                passage_count,
                diagnostics_count,
            });
        }
        Ok(entries)
    }
}

fn find_literal_in_text(text: &str, needle: &str, passage_ids: &[PassageId]) -> Vec<FindMatch> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        out.push(FindMatch {
            start_byte: start,
            end_byte: end,
            passage_ids: passage_ids.to_vec(),
        });
        let step = text[start..].chars().next().map_or(1, char::len_utf8);
        from = start + step;
    }
    out
}

fn collect_schema_rows(conn: &Connection) -> Result<BTreeMap<String, (String, String)>, ClecError> {
    let mut stmt = conn
        .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_%' AND sql IS NOT NULL ORDER BY name",
        )
        .map_err(map_sql_pkg)?;
    let mut rows = stmt.query([]).map_err(map_sql_pkg)?;
    let mut map = BTreeMap::new();
    while let Some(row) = rows.next().map_err(map_sql_pkg)? {
        let typ: String = row.get(0).map_err(map_sql_pkg)?;
        let name: String = row.get(1).map_err(map_sql_pkg)?;
        let sql: String = row.get(2).map_err(map_sql_pkg)?;
        map.insert(name, (typ, sql));
    }
    Ok(map)
}

fn map_sql_pkg(err: rusqlite::Error) -> ClecError {
    if err.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
        return ClecError::new(
            ErrorCode::TransferTimeout,
            "Local search deadline exceeded during SQLite query.",
        );
    }
    ClecError::new(ErrorCode::InvalidPackage, format!("SQLite error: {err}"))
}

fn map_sql_query_err(err: rusqlite::Error, context: &str) -> ClecError {
    if err.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
        return ClecError::new(
            ErrorCode::TransferTimeout,
            "Local search deadline exceeded during SQLite query.",
        );
    }
    ClecError::new(ErrorCode::InternalError, format!("{context}: {err}"))
}

fn bad_cue() -> ClecError {
    ClecError::new(
        ErrorCode::InvalidPackage,
        "Invalid cue byte span or timestamps.",
    )
}

fn read_sqlite_varint(bytes: &[u8], pos: &mut usize) -> Option<u64> {
    let mut val = 0u64;
    for i in 0..9 {
        let b = *bytes.get(*pos)?;
        *pos += 1;
        if i == 8 {
            val = (val << 8) | u64::from(b);
            return Some(val);
        }
        val = (val << 7) | u64::from(b & 0x7f);
        if (b & 0x80) == 0 {
            return Some(val);
        }
    }
    None
}

fn decode_fts5_docsize(sz: &[u8]) -> Option<(usize, usize)> {
    let mut pos = 0usize;
    let t = read_sqlite_varint(sz, &mut pos)?;
    let b = read_sqlite_varint(sz, &mut pos)?;
    if pos != sz.len() {
        return None;
    }
    Some((usize::try_from(t).ok()?, usize::try_from(b).ok()?))
}

#[derive(Clone, Copy)]
struct PostingEntry {
    rowid: i64,
    col: u8,
    offset: u32,
    term_off: u32,
    term_len: u16,
}

struct SortedPostingBucket {
    arena: Vec<u8>,
    entries: Vec<PostingEntry>,
}

static BUCKET_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

struct OwnedBucketDir(PathBuf);

impl OwnedBucketDir {
    fn create_in(work_dir: &Path, label: &str) -> Result<Self, ClecError> {
        for _ in 0..32 {
            let seq = BUCKET_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = work_dir.join(format!(".clec-fts-{label}-{}-{seq}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(ClecError::new(
                        ErrorCode::IoError,
                        format!("Temp bucket dir failed: {e}"),
                    ));
                }
            }
        }
        Err(ClecError::new(
            ErrorCode::IoError,
            "Failed to allocate unique temp bucket directory.",
        ))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for OwnedBucketDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

enum BucketStorage {
    Memory(Vec<u8>),
    Files {
        _temp_dir: OwnedBucketDir,
        writers: Vec<Option<BufWriter<File>>>,
        paths: Vec<PathBuf>,
    },
}

struct PostingBuckets {
    num_buckets: usize,
    storage: BucketStorage,
}

impl PostingBuckets {
    fn new(work_dir: &Path, label: &str, num_buckets: usize) -> Result<Self, ClecError> {
        if num_buckets <= 1 {
            return Ok(Self {
                num_buckets: 1,
                storage: BucketStorage::Memory(Vec::new()),
            });
        }
        let temp_dir = OwnedBucketDir::create_in(work_dir, label)?;
        let mut writers = Vec::with_capacity(num_buckets);
        let mut paths = Vec::with_capacity(num_buckets);
        for b in 0..num_buckets {
            let p = temp_dir.path().join(format!("b{b}.bin"));
            let f = File::create(&p).map_err(|e| {
                ClecError::new(
                    ErrorCode::IoError,
                    format!("Bucket file create failed: {e}"),
                )
            })?;
            writers.push(Some(BufWriter::with_capacity(32 * 1024, f)));
            paths.push(p);
        }
        Ok(Self {
            num_buckets,
            storage: BucketStorage::Files {
                _temp_dir: temp_dir,
                writers,
                paths,
            },
        })
    }

    fn num_buckets(&self) -> usize {
        self.num_buckets
    }

    fn push(&mut self, rowid: i64, col: u8, offset: u32, term: &[u8]) -> Result<(), ClecError> {
        let term_len = u16::try_from(term.len())
            .map_err(|_| ClecError::new(ErrorCode::InvalidPackage, "FTS5 token exceeds 64 KiB."))?;
        let mut header = [0u8; 15];
        header[0..8].copy_from_slice(&rowid.to_le_bytes());
        header[8] = col;
        header[9..13].copy_from_slice(&offset.to_le_bytes());
        header[13..15].copy_from_slice(&term_len.to_le_bytes());
        match &mut self.storage {
            BucketStorage::Memory(buf) => {
                buf.extend_from_slice(&header);
                buf.extend_from_slice(term);
            }
            BucketStorage::Files { writers, .. } => {
                let idx = (rowid.unsigned_abs() as usize) % self.num_buckets;
                let w = writers[idx].as_mut().ok_or_else(|| {
                    ClecError::new(ErrorCode::InternalError, "Bucket writer already closed.")
                })?;
                w.write_all(&header).map_err(|e| {
                    ClecError::new(ErrorCode::IoError, format!("Bucket write failed: {e}"))
                })?;
                w.write_all(term).map_err(|e| {
                    ClecError::new(ErrorCode::IoError, format!("Bucket write failed: {e}"))
                })?;
            }
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), ClecError> {
        if let BucketStorage::Files { writers, .. } = &mut self.storage {
            for slot in writers.iter_mut() {
                if let Some(mut w) = slot.take() {
                    w.flush().map_err(|e| {
                        ClecError::new(ErrorCode::IoError, format!("Bucket flush failed: {e}"))
                    })?;
                }
            }
        }
        Ok(())
    }

    fn take_sorted(&mut self, bucket_idx: usize) -> Result<SortedPostingBucket, ClecError> {
        let raw = match &mut self.storage {
            BucketStorage::Memory(buf) => std::mem::take(buf),
            BucketStorage::Files { paths, .. } => {
                let path = &paths[bucket_idx];
                let data = fs::read(path).map_err(|e| {
                    ClecError::new(ErrorCode::IoError, format!("Bucket read failed: {e}"))
                })?;
                let _ = fs::remove_file(path);
                data
            }
        };

        let mut arena = Vec::new();
        let mut entries = Vec::new();
        let mut pos = 0usize;
        while pos < raw.len() {
            if pos + 15 > raw.len() {
                return Err(ClecError::new(
                    ErrorCode::InternalError,
                    "Truncated posting bucket record.",
                ));
            }
            let rowid = i64::from_le_bytes(raw[pos..pos + 8].try_into().unwrap());
            let col = raw[pos + 8];
            let offset = u32::from_le_bytes(raw[pos + 9..pos + 13].try_into().unwrap());
            let term_len = u16::from_le_bytes(raw[pos + 13..pos + 15].try_into().unwrap());
            pos += 15;
            let tlen = term_len as usize;
            if pos + tlen > raw.len() {
                return Err(ClecError::new(
                    ErrorCode::InternalError,
                    "Truncated posting bucket term.",
                ));
            }
            let term_off = u32::try_from(arena.len()).map_err(|_| {
                ClecError::new(ErrorCode::InternalError, "Posting bucket arena overflow.")
            })?;
            arena.extend_from_slice(&raw[pos..pos + tlen]);
            pos += tlen;
            entries.push(PostingEntry {
                rowid,
                col,
                offset,
                term_off,
                term_len,
            });
        }

        entries.sort_unstable_by(|a, b| {
            a.rowid
                .cmp(&b.rowid)
                .then_with(|| a.col.cmp(&b.col))
                .then_with(|| a.offset.cmp(&b.offset))
                .then_with(|| {
                    let ta = &arena[a.term_off as usize..a.term_off as usize + a.term_len as usize];
                    let tb = &arena[b.term_off as usize..b.term_off as usize + b.term_len as usize];
                    ta.cmp(tb)
                })
        });

        for pair in entries.windows(2) {
            let a = pair[0];
            let b = pair[1];
            if a.rowid == b.rowid && a.col == b.col && a.offset == b.offset {
                return Err(ClecError::new(
                    ErrorCode::InvalidPackage,
                    "Duplicate FTS5 posting at same rowid, column, and offset.",
                ));
            }
        }

        Ok(SortedPostingBucket { arena, entries })
    }
}

fn postings_equal(a: &SortedPostingBucket, b: &SortedPostingBucket) -> bool {
    if a.entries.len() != b.entries.len() {
        return false;
    }
    for (ea, eb) in a.entries.iter().zip(b.entries.iter()) {
        if ea.rowid != eb.rowid || ea.col != eb.col || ea.offset != eb.offset {
            return false;
        }
        let ta = &a.arena[ea.term_off as usize..ea.term_off as usize + ea.term_len as usize];
        let tb = &b.arena[eb.term_off as usize..eb.term_off as usize + eb.term_len as usize];
        if ta != tb {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ByteSpan;
    use crate::lexical::index_tokens_string;
    use crate::snapshot::publish_release;
    use std::fs;
    use std::io::Read;
    use std::path::PathBuf;

    #[test]
    fn rejects_legacy_format_revision_databases() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("legacy.sqlite");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO metadata VALUES('formatRevision','3');",
        )
        .unwrap();
        drop(conn);

        let release = ReleaseHash::parse(&"a".repeat(64)).unwrap();
        let err = CorpusStore::open_readonly(&db_path, release.clone())
            .err()
            .unwrap();
        assert_eq!(err.code, ErrorCode::InvalidPackage);
        assert!(err.message.contains("clec-native-v1"));

        let v1_path = dir.path().join("v1.sqlite");
        let conn_v1 = Connection::open(&v1_path).unwrap();
        conn_v1
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO metadata VALUES('corpus_format','clec-native-v1');",
            )
            .unwrap();
        drop(conn_v1);
        let err_v1 = CorpusStore::open_readonly(&v1_path, release).err().unwrap();
        assert_eq!(err_v1.code, ErrorCode::InvalidPackage);
    }

    #[test]
    fn validates_exact_content_sharing_across_works_and_catches_tamper() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("corpus.sqlite");
        let raw = "0050與QQQ配置 4%提領".as_bytes();
        let content_hash = sha256_hex(raw);

        let w1 = WorkId::from_work_key("work-alpha").unwrap();
        let w2 = WorkId::from_work_key("work-beta").unwrap();
        let s1 = SourceId::derive(
            &w1,
            "a.txt",
            SourceRole::Transcript,
            Attribution::MachineUnverified,
            &content_hash,
            None,
            None,
        );
        let s2 = SourceId::derive(
            &w2,
            "a.txt",
            SourceRole::Document,
            Attribution::PublisherVerified,
            &content_hash,
            None,
            None,
        );
        let span = ByteSpan::new(0, raw.len(), None).unwrap();
        let p1 = PassageId::derive(&s1, 0, std::slice::from_ref(&span));
        let p2 = PassageId::derive(&s2, 0, std::slice::from_ref(&span));

        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
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
        .unwrap();
        conn.execute(
            "INSERT INTO blobs VALUES(?,?,?)",
            params![content_hash, raw, raw.len() as i64],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO works VALUES(?,?,?)",
            params![w1.as_str(), "work-alpha", "Alpha"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO works VALUES(?,?,?)",
            params![w2.as_str(), "work-beta", "Beta"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                s1.as_str(),
                w1.as_str(),
                "a.txt",
                "Alpha",
                "transcript",
                "machine_unverified",
                "unverified",
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None,
                content_hash
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                s2.as_str(),
                w2.as_str(),
                "a.txt",
                "Beta",
                "document",
                "publisher_verified",
                "verified",
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None,
                content_hash
            ],
        )
        .unwrap();
        let eq_hash =
            sha256_hex(format!("equiv-v1:{}", std::str::from_utf8(raw).unwrap()).as_bytes());
        conn.execute(
            "INSERT INTO source_canonical_map VALUES(?,?,?,?,?)",
            params![
                s1.as_str(),
                s1.as_str(),
                eq_hash,
                "plain_text",
                "unique_in_work_role"
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO source_canonical_map VALUES(?,?,?,?,?)",
            params![
                s2.as_str(),
                s2.as_str(),
                eq_hash,
                "plain_text",
                "unique_in_work_role"
            ],
        )
        .unwrap();

        let text = std::str::from_utf8(raw).unwrap();
        for (pid, sid, wid, title) in [(&p1, &s1, &w1, "Alpha"), (&p2, &s2, &w2, "Beta")] {
            conn.execute(
                "INSERT INTO passages VALUES(?,?,?,?,?,?,?,?,?)",
                params![
                    pid.as_str(),
                    sid.as_str(),
                    wid.as_str(),
                    0i64,
                    "whole",
                    0i64,
                    Option::<String>::None,
                    Option::<String>::None,
                    text
                ],
            )
            .unwrap();
            let rowid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO passage_spans VALUES(?,?,?,?,?)",
                params![
                    pid.as_str(),
                    0i64,
                    0i64,
                    raw.len() as i64,
                    Option::<i64>::None
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(?,?,?)",
                params![rowid, index_tokens_string(title), index_tokens_string(text)],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO inventory VALUES('a.txt','work-alpha','indexed','ok',?)",
            params![content_hash],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO inventory VALUES('a.txt','work-beta','indexed','ok',?)",
            params![content_hash],
        )
        .unwrap();
        drop(conn);

        let release = ReleaseHash::parse(&"b".repeat(64)).unwrap();
        let counts = CorpusCounts {
            works: 2,
            sources: 2,
            canonical_sources: 2,
            blobs: 1,
            passages: 2,
            cues: 0,
            inventory: 2,
        };
        CorpusStore::validate_staging_db(&db_path, release.clone(), &counts).unwrap();
        let store = CorpusStore::open_readonly(&db_path, release.clone()).unwrap();
        let read1 = store.read_passage(&p1, 0, None).unwrap();
        let read2 = store.read_passage(&p2, 0, None).unwrap();
        assert_eq!(read1.work.work_id, w1);
        assert_eq!(read2.work.work_id, w2);
        assert_eq!(read1.source.role, SourceRole::Transcript);
        assert_eq!(read2.source.role, SourceRole::Document);
        drop(store);

        let conn2 = Connection::open(&db_path).unwrap();
        conn2
            .execute(
                "UPDATE passages SET text='tampered' WHERE id=?",
                [p1.as_str()],
            )
            .unwrap();
        drop(conn2);

        assert_eq!(
            CorpusStore::validate_staging_db(&db_path, release.clone(), &counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );
        let store2 = CorpusStore::open_readonly(&db_path, release).unwrap();
        assert_eq!(
            store2.read_passage(&p1, 0, None).unwrap_err().code,
            ErrorCode::IntegrityMismatch
        );
    }

    fn publish_and_extract_sqlite(
        tmp: &Path,
        files: &[(&str, &str, &str)],
    ) -> (PathBuf, CorpusCounts) {
        let ws = tmp.join("ws");
        fs::create_dir_all(&ws).unwrap();
        let mut sources = Vec::new();
        for (path, title, content) in files {
            fs::write(ws.join(path), content).unwrap();
            sources.push(serde_json::json!({
                "work": "w1",
                "path": path,
                "title": title,
                "role": "transcript",
                "attribution": "authored_fixture",
                "quality": "fixture",
                "status": "ready"
            }));
        }
        let intake = tmp.join("intake.json");
        fs::write(
            &intake,
            serde_json::to_string(&serde_json::json!({
                "schemaVersion": 1,
                "works": [{ "key": "w1", "title": "Work One" }],
                "sources": sources
            }))
            .unwrap(),
        )
        .unwrap();
        let rel = tmp.join("release");
        let manifest = publish_release(&ws, &intake, &rel).unwrap();
        let db_path = tmp.join("corpus.sqlite");
        let zst = fs::File::open(rel.join("corpus.sqlite.zst")).unwrap();
        let mut dec = zstd::stream::Decoder::new(zst).unwrap();
        let mut buf = Vec::new();
        dec.read_to_end(&mut buf).unwrap();
        fs::write(&db_path, &buf).unwrap();
        (db_path, manifest.counts)
    }

    #[test]
    fn rejects_empty_and_misplaced_fts_postings_with_same_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let (db_path, counts) = publish_and_extract_sqlite(
            tmp.path(),
            &[
                ("a.txt", "Title Alpha", "alpha first body"),
                ("b.txt", "Title Beta", "beta second body"),
            ],
        );

        let empty_db = tmp.path().join("empty_fts.sqlite");
        fs::copy(&db_path, &empty_db).unwrap();
        {
            let conn = Connection::open(&empty_db).unwrap();
            conn.execute_batch(
                "INSERT INTO search(search) VALUES('delete-all');
                 INSERT INTO search(rowid, title_tokens, body_tokens) SELECT rowid, '', '' FROM passages;",
            )
            .unwrap();
        }
        let release = ReleaseHash::parse(&"d".repeat(64)).unwrap();
        assert_eq!(
            CorpusStore::validate_staging_db(&empty_db, release.clone(), &counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );

        let swap_col_db = tmp.path().join("swap_col_fts.sqlite");
        fs::copy(&db_path, &swap_col_db).unwrap();
        {
            let conn = Connection::open(&swap_col_db).unwrap();
            let t1 = index_tokens_string("alpha first body");
            let b1 = index_tokens_string("Title Alpha");
            let t2 = index_tokens_string("Title Beta");
            let b2 = index_tokens_string("beta second body");
            conn.execute_batch("INSERT INTO search(search) VALUES('delete-all');")
                .unwrap();
            conn.execute(
                "INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(1, ?, ?), (2, ?, ?)",
                params![t1, b1, t2, b2],
            )
            .unwrap();
        }
        assert_eq!(
            CorpusStore::validate_staging_db(&swap_col_db, release.clone(), &counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );

        let swap_pos_db = tmp.path().join("swap_pos_fts.sqlite");
        fs::copy(&db_path, &swap_pos_db).unwrap();
        {
            let conn = Connection::open(&swap_pos_db).unwrap();
            let t1 = index_tokens_string("Title Alpha");
            let b1 = index_tokens_string("body first alpha");
            let t2 = index_tokens_string("Title Beta");
            let b2 = index_tokens_string("beta second body");
            conn.execute_batch("INSERT INTO search(search) VALUES('delete-all');")
                .unwrap();
            conn.execute(
                "INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(1, ?, ?), (2, ?, ?)",
                params![t1, b1, t2, b2],
            )
            .unwrap();
        }
        assert_eq!(
            CorpusStore::validate_staging_db(&swap_pos_db, release, &counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );
    }

    #[test]
    fn rejects_corrupt_fts_engine_state_and_preserves_valid_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let (db_path, counts) = publish_and_extract_sqlite(
            tmp.path(),
            &[
                ("a.txt", "Title Alpha", "alpha first body"),
                ("b.txt", "Title Beta", "beta second body"),
                ("c.txt", "Title Gamma", "gamma third body"),
            ],
        );
        let release = ReleaseHash::parse(&"f".repeat(64)).unwrap();

        let original_bytes = fs::read(&db_path).unwrap();
        let original_hash = sha256_hex(&original_bytes);
        CorpusStore::validate_staging_db(&db_path, release.clone(), &counts).unwrap();
        let after_bytes = fs::read(&db_path).unwrap();
        assert_eq!(sha256_hex(&after_bytes), original_hash);
        assert_eq!(after_bytes, original_bytes);

        for (name, sql) in [
            (
                "bad_stats_zero",
                "UPDATE search_data SET block=x'000000' WHERE id=1",
            ),
            (
                "bad_stats_skewed",
                "UPDATE search_data SET block=x'010101' WHERE id=1",
            ),
            (
                "corrupt_structure",
                "UPDATE search_data SET block=x'ffffffffffffffff' WHERE id=10",
            ),
            (
                "corrupt_segment",
                "UPDATE search_data SET block=x'ff00ff' WHERE id > 10",
            ),
        ] {
            let p = tmp.path().join(format!("{name}.sqlite"));
            fs::copy(&db_path, &p).unwrap();
            {
                let conn = Connection::open(&p).unwrap();
                conn.execute(sql, []).unwrap();
            }
            let err =
                CorpusStore::validate_staging_db(&p, release.clone(), &counts).expect_err(name);
            assert!(
                matches!(
                    err.code,
                    ErrorCode::IntegrityMismatch | ErrorCode::InvalidPackage
                ),
                "unexpected error for {name}: {err:?}"
            );
        }
    }

    #[test]
    fn rejects_tampered_cues_spans_and_continuations_while_accepting_hard_cut_subspans() {
        let tmp = tempfile::tempdir().unwrap();
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nalpha investment.\n\n2\n00:00:03,000 --> 00:00:04,000\nbeta savings.\n";
        let (db_path, counts) = publish_and_extract_sqlite(tmp.path(), &[("a.srt", "Demo", srt)]);
        let release = ReleaseHash::parse(&"e".repeat(64)).unwrap();

        let cue_shift_db = tmp.path().join("cue_shift.sqlite");
        fs::copy(&db_path, &cue_shift_db).unwrap();
        {
            let conn = Connection::open(&cue_shift_db).unwrap();
            conn.execute(
                "UPDATE cues SET start_ms = start_ms + 86400000, end_ms = end_ms + 86400000",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            CorpusStore::validate_staging_db(&cue_shift_db, release.clone(), &counts)
                .unwrap_err()
                .code,
            ErrorCode::InvalidPackage
        );

        let wrong_cue_db = tmp.path().join("wrong_cue.sqlite");
        fs::copy(&db_path, &wrong_cue_db).unwrap();
        {
            let conn = Connection::open(&wrong_cue_db).unwrap();
            conn.execute(
                "UPDATE passage_spans SET cue_ordinal = 1 WHERE span_ordinal = 0",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            CorpusStore::validate_staging_db(&wrong_cue_db, release.clone(), &counts)
                .unwrap_err()
                .code,
            ErrorCode::InvalidPackage
        );

        let bad_cont_db = tmp.path().join("bad_cont.sqlite");
        fs::copy(&db_path, &bad_cont_db).unwrap();
        {
            let conn = Connection::open(&bad_cont_db).unwrap();
            conn.execute(
                "UPDATE passages SET is_continuation = 1, continued_from = id",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            CorpusStore::validate_staging_db(&bad_cont_db, release.clone(), &counts)
                .unwrap_err()
                .code,
            ErrorCode::InvalidPackage
        );

        let tmp_hc = tempfile::tempdir().unwrap();
        let long_cue_body = "甲".repeat(2500);
        let hc_srt = format!("1\n00:00:01,000 --> 00:00:05,000\n{long_cue_body}\n");
        let (hc_db, hc_counts) =
            publish_and_extract_sqlite(tmp_hc.path(), &[("long.srt", "Long Cue", &hc_srt)]);
        assert_eq!(hc_counts.cues, 1);
        assert_eq!(hc_counts.passages, 2);
        CorpusStore::validate_staging_db(&hc_db, release, &hc_counts).unwrap();
    }

    #[test]
    fn rejects_noncanonical_passages_and_wrong_canonical_winner_and_tests_bucketed_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nalpha beta\n";
        let txt = "alpha beta\n";
        let md = "# 語音筆記：測試\n\n## [0:00:01,000 – 0:00:02,000]\nalpha beta\n";
        fs::write(ws.join("ep.srt"), srt).unwrap();
        fs::write(ws.join("ep.txt"), txt).unwrap();
        fs::write(ws.join("ep.md"), md).unwrap();

        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            serde_json::to_string(&serde_json::json!({
                "schemaVersion": 1,
                "works": [{ "key": "w1", "title": "Work One" }],
                "sources": [
                    {"work": "w1", "path": "ep.srt", "title": "Ep SRT", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive", "status": "ready"},
                    {"work": "w1", "path": "ep.txt", "title": "Ep TXT", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive", "status": "ready"},
                    {"work": "w1", "path": "ep.md", "title": "Ep MD", "role": "transcript", "attribution": "unverified_transcript", "quality": "archive", "status": "ready"}
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let rel = tmp.path().join("release");
        let manifest = publish_release(&ws, &intake, &rel).unwrap();
        assert_eq!(manifest.counts.sources, 3);
        assert_eq!(manifest.counts.canonical_sources, 1);
        assert_eq!(manifest.counts.passages, 1);

        let db_path = tmp.path().join("corpus.sqlite");
        let zst = fs::File::open(rel.join("corpus.sqlite.zst")).unwrap();
        let mut dec = zstd::stream::Decoder::new(zst).unwrap();
        let mut buf = Vec::new();
        dec.read_to_end(&mut buf).unwrap();
        fs::write(&db_path, &buf).unwrap();

        let release = ReleaseHash::parse(&"1".repeat(64)).unwrap();
        CorpusStore::validate_staging_db(&db_path, release.clone(), &manifest.counts).unwrap();

        let store = CorpusStore::open_readonly(&db_path, release.clone()).unwrap();
        let all_sources = store.list_sources(None, None, None, false).unwrap();
        assert_eq!(all_sources.len(), 3);
        let canon_only = store.list_sources(None, None, None, true).unwrap();
        assert_eq!(canon_only.len(), 1);
        assert_eq!(canon_only[0].path, "ep.srt");
        assert_eq!(canon_only[0].equivalent_count, 3);
        let txt_entry = all_sources.iter().find(|s| s.path == "ep.txt").unwrap();
        assert!(!txt_entry.is_canonical);
        assert_eq!(txt_entry.canonical_source_id, canon_only[0].source_id);
        let txt_orig = store
            .read_source_original(&txt_entry.source_id, None)
            .unwrap();
        assert_eq!(txt_orig.original_text, txt);
        assert_eq!(txt_orig.equivalent_sources.len(), 3);
        let txt_ov = store.read_source_overview(&txt_entry.source_id).unwrap();
        assert!(txt_ov.passage_ids.is_empty());
        assert_eq!(txt_ov.canonical_passage_ids.len(), 1);
        drop(store);

        let swap_winner_db = tmp.path().join("swap_winner.sqlite");
        fs::copy(&db_path, &swap_winner_db).unwrap();
        {
            let conn = Connection::open(&swap_winner_db).unwrap();
            let txt_id = txt_entry.source_id.as_str();
            let srt_id = canon_only[0].source_id.as_str();
            conn.execute(
                "UPDATE source_canonical_map SET canonical_source_id = ?, equivalence_basis = CASE WHEN source_id = ? THEN 'canonical_by_timing_and_format' ELSE 'collapsed_to_canonical' END",
                params![txt_id, txt_id],
            )
            .unwrap();
            let _ = srt_id;
        }
        assert_eq!(
            CorpusStore::validate_staging_db(&swap_winner_db, release.clone(), &manifest.counts)
                .unwrap_err()
                .code,
            ErrorCode::InvalidPackage
        );

        let mut bucket_test = PostingBuckets::new(tmp.path(), "unit", 4).unwrap();
        bucket_test.push(1, 0, 0, b"t6162").unwrap();
        bucket_test.push(5, 1, 2, b"t6364").unwrap();
        bucket_test.flush().unwrap();
        let b1 = bucket_test.take_sorted(1).unwrap();
        assert_eq!(b1.entries.len(), 2);
    }

    #[test]
    fn validates_and_rejects_corruptions_on_2001_passage_64_bucket_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();

        let passage_count = 2001usize;
        let mut intake_sources = Vec::with_capacity(passage_count);
        for i in 1..=passage_count {
            let rel = format!("p{i:04}.txt");
            let body = format!("tok{i:04} alpha beta");
            fs::write(ws.join(&rel), body).unwrap();
            intake_sources.push(serde_json::json!({
                "work": "w2001",
                "path": rel,
                "title": format!("Title {i:04}"),
                "role": "document",
                "attribution": "authored_fixture",
                "quality": "fixture",
                "status": "ready"
            }));
        }
        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            serde_json::to_string(&serde_json::json!({
                "schemaVersion": 1,
                "works": [{ "key": "w2001", "title": "Large 64-Bucket Work" }],
                "sources": intake_sources
            }))
            .unwrap(),
        )
        .unwrap();

        let rel = tmp.path().join("release");
        let manifest = publish_release(&ws, &intake, &rel).unwrap();
        assert_eq!(manifest.counts.passages, passage_count);

        let db_path = tmp.path().join("corpus.sqlite");
        let zst = fs::File::open(rel.join("corpus.sqlite.zst")).unwrap();
        let mut dec = zstd::stream::Decoder::new(zst).unwrap();
        let mut buf = Vec::new();
        dec.read_to_end(&mut buf).unwrap();
        fs::write(&db_path, &buf).unwrap();

        let release = ReleaseHash::parse(&"9".repeat(64)).unwrap();
        let staging_check_dir = tmp.path().join("stage_ok");
        fs::create_dir_all(&staging_check_dir).unwrap();
        let stage_ok_db = staging_check_dir.join("corpus.sqlite");
        fs::copy(&db_path, &stage_ok_db).unwrap();
        CorpusStore::validate_staging_db(&stage_ok_db, release.clone(), &manifest.counts).unwrap();
        assert_eq!(
            fs::read_dir(&staging_check_dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(".clec-fts-"))
                .count(),
            0
        );

        let rewrite_search = |target_db: &Path, mutator: &dyn Fn(usize, String) -> String| {
            let conn = Connection::open(target_db).unwrap();
            let mut rows_data: Vec<(i64, String, String)> = Vec::with_capacity(passage_count);
            {
                let mut stmt = conn
                    .prepare(
                        "SELECT p.rowid, s.title, p.text FROM passages p JOIN sources s ON s.id = p.source_id ORDER BY p.rowid",
                    )
                    .unwrap();
                let mut rows = stmt.query([]).unwrap();
                while let Some(r) = rows.next().unwrap() {
                    let rowid: i64 = r.get(0).unwrap();
                    let title: String = r.get(1).unwrap();
                    let text: String = r.get(2).unwrap();
                    let body_tokens = mutator(rowid as usize, index_tokens_string(&text));
                    rows_data.push((rowid, index_tokens_string(&title), body_tokens));
                }
            }
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute_batch("INSERT INTO search(search) VALUES('delete-all');")
                .unwrap();
            {
                let mut ins = tx
                    .prepare("INSERT INTO search(rowid, title_tokens, body_tokens) VALUES(?, ?, ?)")
                    .unwrap();
                for (rowid, t, b) in &rows_data {
                    ins.execute(params![rowid, t, b]).unwrap();
                }
            }
            tx.commit().unwrap();
        };

        let boundary_dir = tmp.path().join("stage_boundary");
        fs::create_dir_all(&boundary_dir).unwrap();
        let boundary_db = boundary_dir.join("corpus.sqlite");
        fs::copy(&db_path, &boundary_db).unwrap();
        rewrite_search(&boundary_db, &|rowid, body| match rowid {
            64 => index_tokens_string("tok0065 alpha beta"),
            65 => index_tokens_string("tok0064 alpha beta"),
            _ => body,
        });
        assert_eq!(
            CorpusStore::validate_staging_db(&boundary_db, release.clone(), &manifest.counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );
        assert_eq!(
            fs::read_dir(&boundary_dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(".clec-fts-"))
                .count(),
            0
        );

        let missing_last_dir = tmp.path().join("stage_missing_last");
        fs::create_dir_all(&missing_last_dir).unwrap();
        let missing_last_db = missing_last_dir.join("corpus.sqlite");
        fs::copy(&db_path, &missing_last_db).unwrap();
        rewrite_search(&missing_last_db, &|rowid, body| {
            if rowid == passage_count {
                index_tokens_string("tok2001 alpha")
            } else {
                body
            }
        });
        assert_eq!(
            CorpusStore::validate_staging_db(&missing_last_db, release.clone(), &manifest.counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );

        let dup_last_dir = tmp.path().join("stage_dup_last");
        fs::create_dir_all(&dup_last_dir).unwrap();
        let dup_last_db = dup_last_dir.join("corpus.sqlite");
        fs::copy(&db_path, &dup_last_db).unwrap();
        rewrite_search(&dup_last_db, &|rowid, body| {
            if rowid == passage_count {
                index_tokens_string("tok2001 alpha alpha")
            } else {
                body
            }
        });
        assert_eq!(
            CorpusStore::validate_staging_db(&dup_last_db, release.clone(), &manifest.counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );

        let global_stat_dir = tmp.path().join("stage_global_stat");
        fs::create_dir_all(&global_stat_dir).unwrap();
        let global_stat_db = global_stat_dir.join("corpus.sqlite");
        fs::copy(&db_path, &global_stat_db).unwrap();
        {
            let conn = Connection::open(&global_stat_db).unwrap();
            conn.execute("UPDATE search_data SET block=x'000000' WHERE id=1", [])
                .unwrap();
        }
        assert_eq!(
            CorpusStore::validate_staging_db(&global_stat_db, release, &manifest.counts)
                .unwrap_err()
                .code,
            ErrorCode::IntegrityMismatch
        );

        let mut dup_offset_buckets = PostingBuckets::new(tmp.path(), "dup_offset", 64).unwrap();
        dup_offset_buckets.push(2001, 1, 0, b"t6162").unwrap();
        dup_offset_buckets.push(2001, 1, 0, b"t6162").unwrap();
        dup_offset_buckets.flush().unwrap();
        assert_eq!(
            dup_offset_buckets
                .take_sorted(2001 % 64)
                .err()
                .unwrap()
                .code,
            ErrorCode::InvalidPackage
        );
    }

    #[test]
    fn df_passage_count_excluded_search_and_read_snapshot_behave_per_contract() {
        let tmp = tempfile::tempdir().unwrap();
        let (db_path, counts) = publish_and_extract_sqlite(
            tmp.path(),
            &[
                ("a.txt", "UniqueTitleOnly", "alpha common body"),
                ("b.txt", "SecondTitle", "beta common body"),
                ("c.txt", "ThirdTitle", "gamma only body"),
            ],
        );
        let release = ReleaseHash::parse(&"7".repeat(64)).unwrap();
        CorpusStore::validate_staging_db(&db_path, release.clone(), &counts).unwrap();
        let mut store = CorpusStore::open_readonly(&db_path, release).unwrap();

        let snap = store.begin_read_snapshot().unwrap();
        assert_eq!(store.passage_count().unwrap(), 3);
        assert_eq!(store.body_term_document_frequency("common").unwrap(), 2);
        assert_eq!(store.body_term_document_frequency("alpha").unwrap(), 1);
        assert_eq!(
            store
                .body_term_document_frequency("uniquetitleonly")
                .unwrap(),
            0
        );

        let filter = CandidateFilter {
            work_filter: None,
            source_filter: None,
            role_filter: None,
            date_from: None,
            date_to: None,
        };
        let fts_common = format!("\"{}\"", encode_fts_token("common"));
        let all_common = store
            .query_bm25_candidates(&fts_common, &filter, 10)
            .unwrap();
        assert_eq!(all_common.len(), 2);

        let excluded = vec![all_common[0].passage_id.clone()];
        let remaining = store
            .query_bm25_candidates_excluding(&fts_common, &filter, &excluded, 10)
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].passage_id, all_common[1].passage_id);

        let writer = Connection::open(&db_path).unwrap();
        assert!(
            writer
                .execute("DELETE FROM passages WHERE rowid = 1", [])
                .is_err()
        );
        assert_eq!(store.passage_count().unwrap(), 3);
        drop(snap);

        let expired = Instant::now() - std::time::Duration::from_millis(1);
        store.set_deadline_progress_handler(expired);
        let err = store
            .query_bm25_candidates(&fts_common, &filter, 10)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::TransferTimeout);
        store.clear_deadline_progress_handler();
        assert_eq!(store.passage_count().unwrap(), 3);
    }
}
