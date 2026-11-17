use std::fmt;
use std::str::FromStr;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CORPUS_FORMAT: &str = "clec-native-v1";
pub const SEGMENTATION_REVISION: &str = "utf8-scalar-1000-2000-v1";
pub const SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_MAX_BYTES: usize = 65_536;

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex_encode(&digest)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn hex_decode(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = from_hex_digit(pair[0])?;
        let lo = from_hex_digit(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn from_hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn is_lower_hex(s: &str, min_len: usize, max_len: usize) -> bool {
    (min_len..=max_len).contains(&s.len())
        && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct WorkId(String);

impl WorkId {
    pub fn from_work_key(work_key: &str) -> Result<Self, ClecError> {
        let trimmed = work_key.trim();
        if trimmed.is_empty() || trimmed.len() > 512 || trimmed.contains('\0') {
            return Err(ClecError::new(
                ErrorCode::InvalidManifest,
                "Work key must be 1..512 non-NUL characters.",
            ));
        }
        let digest = sha256_hex(format!("work:{trimmed}").as_bytes());
        Ok(Self(format!("w_{}", &digest[..24])))
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        let Some(rest) = raw.strip_prefix("w_") else {
            return Err(ClecError::new(
                ErrorCode::InvalidReference,
                "WorkId must start with 'w_'.",
            ));
        };
        if !is_lower_hex(rest, 16, 64) {
            return Err(ClecError::new(
                ErrorCode::InvalidReference,
                "WorkId suffix must be 16..64 lowercase hex characters.",
            ));
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WorkId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for WorkId {
    type Err = ClecError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct SourceId(String);

impl SourceId {
    pub fn derive(
        work_id: &WorkId,
        path: &str,
        role: SourceRole,
        attribution: Attribution,
        content_hash: &str,
        date: Option<&DateYmd>,
        date_basis: Option<&str>,
    ) -> Self {
        let date_str = date.map_or("", DateYmd::as_str);
        let basis_str = date_basis.unwrap_or("");
        let material = format!(
            "source:{}:{}:{}:{}:{}:{}:{}",
            work_id.as_str(),
            path,
            role.as_str(),
            attribution.as_str(),
            content_hash,
            date_str,
            basis_str
        );
        let digest = sha256_hex(material.as_bytes());
        Self(format!("s_{}", &digest[..24]))
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        let Some(rest) = raw.strip_prefix("s_") else {
            return Err(ClecError::new(
                ErrorCode::InvalidReference,
                "SourceId must start with 's_'.",
            ));
        };
        if !is_lower_hex(rest, 16, 64) {
            return Err(ClecError::new(
                ErrorCode::InvalidReference,
                "SourceId suffix must be 16..64 lowercase hex characters.",
            ));
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SourceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for SourceId {
    type Err = ClecError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct PassageId(String);

impl PassageId {
    pub fn derive(source_id: &SourceId, ordinal: usize, spans: &[ByteSpan]) -> Self {
        let mut material = format!(
            "passage:{}:{}:{}:",
            source_id.as_str(),
            ordinal,
            SEGMENTATION_REVISION
        );
        for span in spans {
            material.push_str(&format!("{}-{};", span.start_byte, span.end_byte));
        }
        let digest = sha256_hex(material.as_bytes());
        Self(format!("p_{}", &digest[..24]))
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        let Some(rest) = raw.strip_prefix("p_") else {
            return Err(ClecError::new(
                ErrorCode::InvalidReference,
                "PassageId must start with 'p_'.",
            ));
        };
        if !is_lower_hex(rest, 16, 64) {
            return Err(ClecError::new(
                ErrorCode::InvalidReference,
                "PassageId suffix must be 16..64 lowercase hex characters.",
            ));
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PassageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for PassageId {
    type Err = ClecError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct ReleaseHash(String);

impl ReleaseHash {
    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        if !is_lower_hex(raw, 64, 64) {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Release hash must be a 64-character lowercase SHA-256 hex digest.",
            ));
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ReleaseHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypedRef {
    Source(SourceId),
    Passage(PassageId),
}

impl TypedRef {
    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        if raw.starts_with("s_") {
            Ok(Self::Source(SourceId::parse(raw)?))
        } else if raw.starts_with("p_") {
            Ok(Self::Passage(PassageId::parse(raw)?))
        } else {
            Err(ClecError::new(
                ErrorCode::InvalidReference,
                "Reference must be a SourceId (s_...) or PassageId (p_...).",
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceRole {
    Transcript,
    Qa,
    Summary,
    Document,
}

impl SourceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transcript => "transcript",
            Self::Qa => "qa",
            Self::Summary => "summary",
            Self::Document => "document",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        match raw {
            "transcript" => Ok(Self::Transcript),
            "qa" => Ok(Self::Qa),
            "summary" => Ok(Self::Summary),
            "document" => Ok(Self::Document),
            _ => Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Source role must be transcript, qa, summary, or document.",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Attribution {
    MachineUnverified,
    UnverifiedTranscript,
    PublisherVerified,
    AuthoredFixture,
}

impl Attribution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MachineUnverified => "machine_unverified",
            Self::UnverifiedTranscript => "unverified_transcript",
            Self::PublisherVerified => "publisher_verified",
            Self::AuthoredFixture => "authored_fixture",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        match raw {
            "machine_unverified" => Ok(Self::MachineUnverified),
            "unverified_transcript" => Ok(Self::UnverifiedTranscript),
            "publisher_verified" => Ok(Self::PublisherVerified),
            "authored_fixture" => Ok(Self::AuthoredFixture),
            _ => Err(ClecError::new(
                ErrorCode::InvalidManifest,
                "Attribution must be machine_unverified, unverified_transcript, publisher_verified, or authored_fixture.",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryKind {
    Whole,
    Paragraph,
    Sentence,
    Qa,
    CueGroup,
    HardCut,
}

impl BoundaryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whole => "whole",
            Self::Paragraph => "paragraph",
            Self::Sentence => "sentence",
            Self::Qa => "qa",
            Self::CueGroup => "cue_group",
            Self::HardCut => "hard_cut",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        match raw {
            "whole" => Ok(Self::Whole),
            "paragraph" => Ok(Self::Paragraph),
            "sentence" => Ok(Self::Sentence),
            "qa" => Ok(Self::Qa),
            "cue_group" => Ok(Self::CueGroup),
            "hard_cut" => Ok(Self::HardCut),
            _ => Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Invalid passage boundary kind in corpus.",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ByteSpan {
    pub start_byte: usize,
    pub end_byte: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cue_ordinal: Option<usize>,
}

impl ByteSpan {
    pub fn new(
        start_byte: usize,
        end_byte: usize,
        cue_ordinal: Option<usize>,
    ) -> Result<Self, ClecError> {
        if start_byte >= end_byte {
            return Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "ByteSpan requires start_byte < end_byte.",
            ));
        }
        Ok(Self {
            start_byte,
            end_byte,
            cue_ordinal,
        })
    }
}

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct DateYmd(String);

impl DateYmd {
    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        let bytes = raw.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Date must use YYYY-MM-DD format.",
            ));
        }
        let year: u32 = raw[0..4]
            .parse()
            .map_err(|_| ClecError::new(ErrorCode::InvalidArgument, "Invalid year in date."))?;
        let month: u32 = raw[5..7]
            .parse()
            .map_err(|_| ClecError::new(ErrorCode::InvalidArgument, "Invalid month in date."))?;
        let day: u32 = raw[8..10]
            .parse()
            .map_err(|_| ClecError::new(ErrorCode::InvalidArgument, "Invalid day in date."))?;
        let max_day = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 => {
                let leap = year.is_multiple_of(4)
                    && (!year.is_multiple_of(100) || year.is_multiple_of(400));
                if leap { 29 } else { 28 }
            }
            _ => {
                return Err(ClecError::new(
                    ErrorCode::InvalidArgument,
                    "Month in YYYY-MM-DD must be 01..12.",
                ));
            }
        };
        if !(1..=max_day).contains(&day) {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Day is out of range for the given month.",
            ));
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidArgument,
    InvalidQuery,
    InvalidReference,
    UnsupportedFeature,
    OutputBudgetTooSmall,
    NoData,
    VersionUnavailable,
    EvidenceNotFound,
    SyncLocked,
    InvalidDataDir,
    IoError,
    InvalidPackage,
    IntegrityMismatch,
    InvalidManifest,
    EmptyCorpus,
    OutputExists,
    UnsafePath,
    InternalError,
}

impl ErrorCode {
    pub fn exit_code(self) -> i32 {
        match self {
            Self::InvalidArgument
            | Self::InvalidQuery
            | Self::InvalidReference
            | Self::UnsupportedFeature
            | Self::OutputBudgetTooSmall => 2,
            Self::NoData | Self::VersionUnavailable | Self::EvidenceNotFound => 3,
            Self::SyncLocked | Self::InvalidDataDir | Self::IoError | Self::OutputExists => 4,
            Self::InvalidPackage
            | Self::IntegrityMismatch
            | Self::InvalidManifest
            | Self::EmptyCorpus
            | Self::UnsafePath => 5,
            Self::InternalError => 1,
        }
    }

    pub fn remedy(self) -> &'static str {
        match self {
            Self::InvalidArgument => {
                "Run `clec --help` or `clec schema` for supported arguments and bounds."
            }
            Self::InvalidQuery => {
                "Provide 1..4 non-empty queries, each 1..512 bytes with 1..64 lexical terms."
            }
            Self::InvalidReference => {
                "Pass a typed WorkId (w_...), SourceId (s_...), or PassageId (p_...) from search or sources."
            }
            Self::UnsupportedFeature => {
                "Omit unsupported Phase 1 flags (such as --sag2); run `clec schema` to inspect supported options."
            }
            Self::OutputBudgetTooSmall => {
                "Increase --max-bytes so at least the response envelope and one whole result fit."
            }
            Self::NoData => "Run `clec sync --manifest PATH` to install a local corpus snapshot.",
            Self::VersionUnavailable => {
                "Run `clec status` and repeat discovery against the active release."
            }
            Self::EvidenceNotFound => {
                "Run `clec sources` or `clec search` to locate valid SourceId or PassageId values."
            }
            Self::SyncLocked => {
                "Wait for the active sync process on --data-dir to finish, then retry."
            }
            Self::InvalidDataDir => {
                "Provide a writable directory path via --data-dir or CLEC_DATA_DIR."
            }
            Self::IoError => {
                "Check filesystem paths, permissions, and available disk space, then retry."
            }
            Self::InvalidPackage => {
                "Provide a valid clec-native-v1 release package and re-run `clec sync --manifest PATH`."
            }
            Self::IntegrityMismatch => {
                "Re-run `clec sync --manifest PATH` from an unmodified publisher release."
            }
            Self::InvalidManifest => {
                "Fix the manifest or intake JSON fields and rebuild the release."
            }
            Self::EmptyCorpus => {
                "Provide at least one admitted ready source when building a corpus."
            }
            Self::OutputExists => "Choose a fresh output directory path for `clec-publish`.",
            Self::UnsafePath => {
                "Use workspace-relative source paths without parent traversal or symlinks escaping workspace."
            }
            Self::InternalError => {
                "Retry the command; if it persists, inspect logs and report the bug."
            }
        }
    }

    pub fn next_action(self) -> &'static str {
        match self {
            Self::NoData => "clec sync --manifest PATH",
            Self::VersionUnavailable => "clec status",
            Self::EvidenceNotFound => "clec sources",
            Self::OutputBudgetTooSmall => "clec search QUERY --max-bytes 65536",
            Self::InvalidArgument | Self::UnsupportedFeature => "clec schema",
            _ => "clec status",
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ClecError {
    pub code: ErrorCode,
    pub message: String,
    pub input_index: Option<usize>,
}

impl ClecError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            input_index: None,
        }
    }

    pub fn with_input_index(mut self, index: usize) -> Self {
        self.input_index = Some(index);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    pub remedy: String,
    pub next: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEnvelope {
    pub schema_version: u32,
    pub ok: bool,
    pub command: Option<String>,
    pub error: ErrorBody,
}

impl ErrorEnvelope {
    pub fn from_error(err: &ClecError, command: Option<&str>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            ok: false,
            command: command.map(ToOwned::to_owned),
            error: ErrorBody {
                code: err.code,
                message: err.message.clone(),
                remedy: err.code.remedy().to_owned(),
                next: err.code.next_action().to_owned(),
                input_index: err.input_index,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_ids_distinguish_variants_and_stay_deterministic() {
        let w1 = WorkId::from_work_key("ep-00318").unwrap();
        let w2 = WorkId::from_work_key("ep-00318").unwrap();
        assert_eq!(w1, w2);
        assert!(w1.as_str().starts_with("w_"));
        assert!(SourceId::parse(w1.as_str()).is_err());
        assert!(PassageId::parse(w1.as_str()).is_err());

        let h1 = sha256_hex(b"hello");
        let h2 = sha256_hex(b"hello!");
        let s1 = SourceId::derive(
            &w1,
            "a.txt",
            SourceRole::Transcript,
            Attribution::MachineUnverified,
            &h1,
            None,
            None,
        );
        let s2 = SourceId::derive(
            &w1,
            "a.txt",
            SourceRole::Transcript,
            Attribution::MachineUnverified,
            &h2,
            None,
            None,
        );
        assert_ne!(s1, s2);
        assert!(s1.as_str().starts_with("s_"));

        let span = ByteSpan::new(0, 5, None).unwrap();
        let p1 = PassageId::derive(&s1, 0, std::slice::from_ref(&span));
        let p2 = PassageId::derive(&s2, 0, &[span]);
        assert_ne!(p1, p2);
        assert!(p1.as_str().starts_with("p_"));
    }

    #[test]
    fn date_validation_rejects_invalid_calendar_dates() {
        assert!(DateYmd::parse("2024-02-29").is_ok());
        assert!(DateYmd::parse("2025-02-29").is_err());
        assert!(DateYmd::parse("2026-13-01").is_err());
        assert!(DateYmd::parse("2026-04-31").is_err());
    }
}
