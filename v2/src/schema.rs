use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use tantivy::{
    Index, IndexSettings,
    schema::{FAST, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing, TextOptions},
    store::{Compressor, ZstdCompressor},
};
use time::{Date, Month};

use crate::tokenizer::{CjkNorm, NAME};

pub(crate) const ZSTD_LEVEL: i32 = 9;

#[derive(Deserialize)]
pub(crate) struct Passage {
    pub doc_id: String,
    pub work_id: String,
    pub source_id: String,
    pub ordinal: u64,
    pub kind: Kind,
    pub quality: u64,
    pub date: Option<String>,
    pub start_sec: Option<u64>,
    pub end_sec: Option<u64>,
    pub title: String,
    #[serde(default)]
    pub heading: String,
    pub body: String,
    #[serde(default)]
    pub origin_url: String,
    #[serde(default)]
    pub other_kinds: Vec<Kind>,
    #[serde(default)]
    pub license_mode: LicenseMode,
}

#[derive(Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LicenseMode {
    #[default]
    Full,
    SnippetOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Doc,
    Transcript,
    Qa,
    Summary,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Doc => "doc",
            Self::Transcript => "transcript",
            Self::Qa => "qa",
            Self::Summary => "summary",
        }
    }
}

pub fn schema() -> Schema {
    let mut schema = Schema::builder();
    schema.add_text_field("doc_id", STRING | STORED);
    for name in ["work_id", "source_id", "kind"] {
        schema.add_text_field(name, STRING | STORED | FAST);
    }
    for name in ["ordinal", "quality", "start_sec", "end_sec"] {
        schema.add_u64_field(name, STORED | FAST);
    }
    schema.add_i64_field("date", STORED | FAST);
    let indexed_text = TextOptions::default().set_stored().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(NAME)
            .set_index_option(IndexRecordOption::WithFreqs),
    );
    for name in ["title", "heading", "body"] {
        schema.add_text_field(name, indexed_text.clone());
    }
    for name in ["origin_url", "other_kinds"] {
        schema.add_text_field(name, STORED);
    }
    schema.add_u64_field("snippet_only", STORED);
    schema.build()
}

pub fn register(index: &Index) {
    index.tokenizers().register(NAME, CjkNorm);
}

pub fn settings() -> IndexSettings {
    IndexSettings {
        docstore_compression: Compressor::Zstd(ZstdCompressor {
            compression_level: Some(ZSTD_LEVEL),
        }),
        docstore_blocksize: 65_536,
        ..Default::default()
    }
}

pub fn parse_date(date: &str) -> Result<i64> {
    let bytes = date.as_bytes();
    ensure!(
        bytes.len() == 10
            && bytes.iter().enumerate().all(|(i, byte)| {
                if i == 4 || i == 7 {
                    *byte == b'-'
                } else {
                    byte.is_ascii_digit()
                }
            }),
        "expected YYYY-MM-DD, got {date:?}"
    );
    let year: i32 = date[..4].parse()?;
    ensure!(year > 0, "expected a positive year");
    let month: u8 = date[5..7].parse()?;
    let day: u8 = date[8..].parse()?;
    Date::from_calendar_date(year, Month::try_from(month)?, day)?;
    Ok(i64::from(year) * 10_000 + i64::from(month) * 100 + i64::from(day))
}

pub(crate) fn format_date(date: i64) -> Option<String> {
    (date != 0).then(|| {
        format!(
            "{:04}-{:02}-{:02}",
            date / 10000,
            date / 100 % 100,
            date % 100
        )
    })
}

// Keep the Stage 0 library entry points available for existing callers.
pub use crate::builder::{build, check_pack_output, pack};
