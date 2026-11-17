use std::fmt;
use std::str::FromStr;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

pub const CORPUS_FORMAT: &str = "clec-native-v2";
pub const SEGMENTATION_REVISION: &str = "utf8-scalar-1000-2000-v1";
pub const TOKENIZATION_REVISION: &str = "jieba-rs-0.11-alnum-pct-v1";
pub const NORMALIZATION_REVISION: &str = "opencc-tw2s-nfkc-lower-v1";
pub const DICTIONARY_REVISION: &str = "jieba-rs-builtin-0.11.0+ferrous-opencc-0.4.0-tw2s";
pub const EQUIVALENCE_REVISION: &str = "ws-fold-cue-or-archive-md-v1";
pub const SCHEMA_VERSION: u32 = 1;
pub(crate) const DEFAULT_MAX_BYTES: usize = 65_536;

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex_encode(&digest)
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
pub(crate) fn hex_decode(input: &str) -> Option<Vec<u8>> {
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

#[cfg(test)]
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

fn deserialize_validated<'de, D, T>(
    deserializer: D,
    parse: fn(&str) -> Result<T, ClecError>,
) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    parse(&raw).map_err(serde::de::Error::custom)
}

fn string_pattern_schema(pattern: &str, description: &str) -> Schema {
    json_schema!({
        "type": "string",
        "pattern": pattern,
        "description": description
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct WorkId(String);

impl<'de> Deserialize<'de> for WorkId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_validated(deserializer, Self::parse)
    }
}

impl JsonSchema for WorkId {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "WorkId".into()
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        string_pattern_schema(
            "^w_[0-9a-f]{16,64}$",
            "Typed WorkId with 'w_' prefix and 16..64 lowercase hex characters",
        )
    }
}

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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct SourceId(String);

impl<'de> Deserialize<'de> for SourceId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_validated(deserializer, Self::parse)
    }
}

impl JsonSchema for SourceId {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "SourceId".into()
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        string_pattern_schema(
            "^s_[0-9a-f]{16,64}$",
            "Typed SourceId with 's_' prefix and 16..64 lowercase hex characters",
        )
    }
}

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
            "source:{}:{}:{}:{}:{}:{}:{}:{}",
            CORPUS_FORMAT,
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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct PassageId(String);

impl<'de> Deserialize<'de> for PassageId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_validated(deserializer, Self::parse)
    }
}

impl JsonSchema for PassageId {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "PassageId".into()
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        string_pattern_schema(
            "^p_[0-9a-f]{16,64}$",
            "Typed PassageId with 'p_' prefix and 16..64 lowercase hex characters",
        )
    }
}

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

    pub(crate) fn as_str_ref(&self) -> &String {
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ReleaseHash(String);

impl<'de> Deserialize<'de> for ReleaseHash {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_validated(deserializer, Self::parse)
    }
}

impl JsonSchema for ReleaseHash {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "ReleaseHash".into()
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        string_pattern_schema(
            "^[0-9a-f]{64}$",
            "64-character lowercase SHA-256 hex digest",
        )
    }
}

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

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
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
    AutomaticUnverified,
    UnverifiedTranscript,
    OriginalUnknown,
    PublisherVerified,
    AuthoredFixture,
}

impl Attribution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MachineUnverified => "machine_unverified",
            Self::AutomaticUnverified => "automatic_unverified",
            Self::UnverifiedTranscript => "unverified_transcript",
            Self::OriginalUnknown => "original_unknown",
            Self::PublisherVerified => "publisher_verified",
            Self::AuthoredFixture => "authored_fixture",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        match raw {
            "machine_unverified" => Ok(Self::MachineUnverified),
            "automatic_unverified" => Ok(Self::AutomaticUnverified),
            "unverified_transcript" => Ok(Self::UnverifiedTranscript),
            "original_unknown" => Ok(Self::OriginalUnknown),
            "publisher_verified" => Ok(Self::PublisherVerified),
            "authored_fixture" => Ok(Self::AuthoredFixture),
            _ => Err(ClecError::new(
                ErrorCode::InvalidManifest,
                "Attribution must be machine_unverified, automatic_unverified, unverified_transcript, original_unknown, publisher_verified, or authored_fixture.",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionKind {
    SubtitleCuePayload,
    ArchiveVoiceNoteMd,
    PlainText,
}

impl ProjectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SubtitleCuePayload => "subtitle_cue_payload",
            Self::ArchiveVoiceNoteMd => "archive_voice_note_md",
            Self::PlainText => "plain_text",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        match raw {
            "subtitle_cue_payload" => Ok(Self::SubtitleCuePayload),
            "archive_voice_note_md" => Ok(Self::ArchiveVoiceNoteMd),
            "plain_text" => Ok(Self::PlainText),
            _ => Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Invalid projection_kind in corpus.",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EquivalenceBasis {
    UniqueInWorkRole,
    CanonicalByTimingAndFormat,
    CollapsedToCanonical,
}

impl EquivalenceBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UniqueInWorkRole => "unique_in_work_role",
            Self::CanonicalByTimingAndFormat => "canonical_by_timing_and_format",
            Self::CollapsedToCanonical => "collapsed_to_canonical",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ClecError> {
        match raw {
            "unique_in_work_role" => Ok(Self::UniqueInWorkRole),
            "canonical_by_timing_and_format" => Ok(Self::CanonicalByTimingAndFormat),
            "collapsed_to_canonical" => Ok(Self::CollapsedToCanonical),
            _ => Err(ClecError::new(
                ErrorCode::InvalidPackage,
                "Invalid equivalence_basis in corpus.",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CanonicalCandidate<'a> {
    pub source_id: &'a SourceId,
    pub path: &'a str,
    pub attribution: Attribution,
    pub is_subtitle: bool,
    pub has_cues: bool,
    pub diagnostics_count: usize,
}

fn extension_priority(path: &str) -> u8 {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "srt" => 0,
        "str" => 1,
        "vtt" => 2,
        "txt" => 3,
        "md" => 4,
        _ => 5,
    }
}

fn attribution_priority(attr: Attribution) -> u8 {
    match attr {
        Attribution::PublisherVerified => 0,
        Attribution::AuthoredFixture => 1,
        Attribution::AutomaticUnverified => 2,
        Attribution::MachineUnverified => 3,
        Attribution::UnverifiedTranscript => 4,
        Attribution::OriginalUnknown => 5,
    }
}

pub(crate) fn select_canonical_index(candidates: &[CanonicalCandidate<'_>]) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            let key_a = (
                !(a.is_subtitle && a.has_cues),
                extension_priority(a.path),
                attribution_priority(a.attribution),
                a.diagnostics_count,
                a.path,
                a.source_id.as_str(),
            );
            let key_b = (
                !(b.is_subtitle && b.has_cues),
                extension_priority(b.path),
                attribution_priority(b.attribution),
                b.diagnostics_count,
                b.path,
                b.source_id.as_str(),
            );
            key_a.cmp(&key_b)
        })
        .map(|(idx, _)| idx)
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(
    description = "Half-open UTF-8 byte span into raw source bytes with startByte < endByte"
)]
pub struct ByteSpan {
    start_byte: usize,
    #[schemars(range(min = 1))]
    end_byte: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    cue_ordinal: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawByteSpan {
    start_byte: usize,
    end_byte: usize,
    cue_ordinal: Option<usize>,
}

impl<'de> Deserialize<'de> for ByteSpan {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawByteSpan::deserialize(deserializer)?;
        Self::new(raw.start_byte, raw.end_byte, raw.cue_ordinal).map_err(serde::de::Error::custom)
    }
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

    pub fn start_byte(&self) -> usize {
        self.start_byte
    }

    pub fn end_byte(&self) -> usize {
        self.end_byte
    }

    pub fn cue_ordinal(&self) -> Option<usize> {
        self.cue_ordinal
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct DateYmd(String);

impl<'de> Deserialize<'de> for DateYmd {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_validated(deserializer, Self::parse)
    }
}

impl JsonSchema for DateYmd {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "DateYmd".into()
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        string_pattern_schema(
            "^\\d{4}-\\d{2}-\\d{2}$",
            "Calendar date in YYYY-MM-DD format",
        )
    }
}

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
    OfflineRequired,
    OutputBudgetTooSmall,
    InvalidJevConfig,
    Sag2BudgetExhausted,
    NoData,
    VersionUnavailable,
    EvidenceNotFound,
    SyncLocked,
    InvalidDataDir,
    TransferFailed,
    TransferTimeout,
    JevHttpStatus,
    IoError,
    InvalidPackage,
    IntegrityMismatch,
    JevInvalidResponse,
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
            | Self::OfflineRequired
            | Self::OutputBudgetTooSmall
            | Self::InvalidJevConfig
            | Self::Sag2BudgetExhausted => 2,
            Self::NoData | Self::VersionUnavailable | Self::EvidenceNotFound => 3,
            Self::SyncLocked
            | Self::InvalidDataDir
            | Self::TransferFailed
            | Self::TransferTimeout
            | Self::JevHttpStatus
            | Self::IoError
            | Self::OutputExists => 4,
            Self::InvalidPackage
            | Self::IntegrityMismatch
            | Self::JevInvalidResponse
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
                "Omit unsupported flags (such as --sag2); run `clec schema` to inspect supported options."
            }
            Self::OfflineRequired => {
                "Remove --offline to allow HTTPS sync, or pass a local --manifest PATH."
            }
            Self::OutputBudgetTooSmall => {
                "Increase --max-bytes so at least the response envelope and one whole result fit."
            }
            Self::InvalidJevConfig => {
                "Configure a valid HTTPS or literal-loopback JEV_BASE_URL, JEV_MODEL, and matching API credential (--key-file, OPENROUTER_API_KEY, or JEV_API_KEY)."
            }
            Self::Sag2BudgetExhausted => {
                "Reduce query scope, candidate size, or retry ordinary local `clec search`."
            }
            Self::NoData => {
                "Run `clec sync --manifest PATH_OR_HTTPS_URL` to install a corpus snapshot."
            }
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
            Self::TransferFailed => {
                "Verify network connectivity, TLS certificates, and the manifest or artifact URL, then retry."
            }
            Self::TransferTimeout => "Check network latency against transfer deadlines and retry.",
            Self::JevHttpStatus => {
                "Check Jev endpoint status and credentials, or retry ordinary local `clec search`."
            }
            Self::IoError => {
                "Check filesystem paths, permissions, and available disk space, then retry."
            }
            Self::InvalidPackage => {
                "Provide a valid clec-native-v2 release package and re-run `clec sync --manifest PATH_OR_HTTPS_URL`."
            }
            Self::IntegrityMismatch => {
                "Re-run `clec sync --manifest PATH_OR_HTTPS_URL` from an unmodified publisher release."
            }
            Self::JevInvalidResponse => {
                "Inspect the Jev endpoint protocol compatibility; the provider returned a malformed or policy-invalid response."
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
            Self::NoData => "clec sync --manifest PATH_OR_HTTPS_URL",
            Self::OfflineRequired => "clec sync --manifest PATH",
            Self::VersionUnavailable => "clec status",
            Self::EvidenceNotFound => "clec sources",
            Self::OutputBudgetTooSmall => "clec search QUERY --max-bytes 65536",
            Self::InvalidArgument | Self::UnsupportedFeature | Self::InvalidJevConfig => {
                "clec schema"
            }
            Self::Sag2BudgetExhausted | Self::JevHttpStatus | Self::JevInvalidResponse => {
                "clec search QUERY"
            }
            _ => "clec status",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Sag2Stage {
    Init,
    InitialRetrieval,
    InitialScoring,
    ExpansionTerms,
    ExpansionRetrieval,
    ExpansionScoring,
    DppRanking,
    Materialization,
    OutputBudget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Sag2ErrorContext {
    pub completed_stage: Sag2Stage,
    pub rounds_completed: usize,
    pub http_attempts: usize,
    pub successful_batches: usize,
    pub scored_occurrences: usize,
    pub sql_candidate_queries: usize,
    pub df_lookups_distinct: usize,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub estimated_token_units: usize,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ClecError {
    pub code: ErrorCode,
    pub message: String,
    pub input_index: Option<usize>,
    pub sag2_stage: Option<Box<Sag2ErrorContext>>,
}

impl ClecError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            input_index: None,
            sag2_stage: None,
        }
    }

    pub fn with_input_index(mut self, index: usize) -> Self {
        self.input_index = Some(index);
        self
    }

    pub fn with_sag2_stage(mut self, stage: Sag2ErrorContext) -> Self {
        self.sag2_stage = Some(Box::new(stage));
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sag2_stage: Option<Sag2ErrorContext>,
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
                sag2_stage: err.sag2_stage.as_deref().cloned(),
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

    #[test]
    fn serde_deserialization_validates_domain_invariants() {
        assert!(serde_json::from_str::<WorkId>("\"bad\"").is_err());
        assert!(serde_json::from_str::<SourceId>("\"w_0123456789abcdef\"").is_err());
        assert!(serde_json::from_str::<PassageId>("\"p_ZZZZ0123456789abcdef\"").is_err());
        assert!(serde_json::from_str::<ReleaseHash>("\"short\"").is_err());
        assert!(serde_json::from_str::<DateYmd>("\"2025-02-29\"").is_err());
        assert!(serde_json::from_str::<ByteSpan>(r#"{"startByte":5,"endByte":5}"#).is_err());
        assert!(serde_json::from_str::<ByteSpan>(r#"{"startByte":6,"endByte":2}"#).is_err());

        let valid_span: ByteSpan =
            serde_json::from_str(r#"{"startByte":2,"endByte":8,"cueOrdinal":0}"#).unwrap();
        assert_eq!(valid_span.start_byte(), 2);
        assert_eq!(valid_span.end_byte(), 8);
        assert_eq!(valid_span.cue_ordinal(), Some(0));
    }
}
