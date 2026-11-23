use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{
    fs,
    io::BufRead,
    path::{Path, PathBuf},
};
use tantivy::{
    Index, IndexSettings, IndexWriter, TantivyDocument,
    indexer::NoMergePolicy,
    schema::{FAST, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing, TextOptions},
    store::{Compressor, ZstdCompressor},
};
use tempfile::{Builder, NamedTempFile};
use time::{Date, Month};

use crate::tokenizer::{CjkNorm, NAME};

const ZSTD_LEVEL: i32 = 9;

#[derive(Deserialize)]
struct Passage {
    doc_id: String,
    work_id: String,
    source_id: String,
    ordinal: u64,
    kind: String,
    quality: u64,
    date: Option<String>,
    start_sec: Option<u64>,
    end_sec: Option<u64>,
    title: String,
    #[serde(default)]
    heading: String,
    body: String,
    #[serde(default)]
    origin_url: String,
    #[serde(default)]
    other_kinds: Vec<String>,
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

pub fn build(input: impl BufRead, output: &Path, threads: usize) -> Result<u64> {
    let output = absolute_destination(output)?;
    ensure_missing(&output)?;
    let temporary = Builder::new()
        .prefix(".clec-index-")
        .tempdir_in(parent(&output))?;
    let count = build_index(input, temporary.path(), threads)?;
    publish_index(temporary.path(), &output)?;
    Ok(count)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn publish_index(from: &Path, to: &Path) -> Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE)?;
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn publish_index(from: &Path, to: &Path) -> Result<()> {
    ensure_missing(to)?;
    fs::rename(from, to)?;
    Ok(())
}

fn build_index(input: impl BufRead, output: &Path, threads: usize) -> Result<u64> {
    let schema = schema();
    let index = Index::builder()
        .schema(schema.clone())
        .settings(settings())
        .create_in_dir(output)?;
    register(&index);
    let mut writer: IndexWriter<TantivyDocument> =
        index.writer_with_num_threads(threads, threads * 64_000_000)?;
    writer.set_merge_policy(Box::new(NoMergePolicy));
    let field = |name| schema.get_field(name).unwrap();
    let mut count = 0;
    for (line_no, line) in input.lines().enumerate() {
        let passage: Passage = serde_json::from_str(&line?)
            .with_context(|| format!("passage at line {}", line_no + 1))?;
        let mut doc = TantivyDocument::new();
        for (name, value) in [
            ("doc_id", passage.doc_id),
            ("work_id", passage.work_id),
            ("source_id", passage.source_id),
            ("kind", passage.kind),
            ("title", passage.title),
            ("heading", passage.heading),
            ("body", passage.body),
            ("origin_url", passage.origin_url),
        ] {
            doc.add_text(field(name), value);
        }
        for (name, value) in [
            ("ordinal", passage.ordinal),
            ("quality", passage.quality),
            ("start_sec", passage.start_sec.unwrap_or(u64::MAX)),
            ("end_sec", passage.end_sec.unwrap_or(u64::MAX)),
        ] {
            doc.add_u64(field(name), value);
        }
        let date = parse_date(passage.date.as_deref().unwrap_or_default())
            .with_context(|| format!("date at line {}", line_no + 1))?;
        doc.add_i64(field("date"), date);
        for kind in passage.other_kinds {
            doc.add_text(field("other_kinds"), kind);
        }
        writer.add_document(doc)?;
        count += 1;
    }
    writer.commit()?;
    let segments = index.searchable_segment_ids()?;
    if segments.len() > 1 {
        writer.merge(&segments).wait()?;
    }
    writer.wait_merging_threads()?;
    ensure!(
        index.searchable_segment_ids()?.len() == 1,
        "expected one nonempty segment"
    );
    Ok(count)
}

fn parse_date(date: &str) -> Result<i64> {
    if date.is_empty() {
        return Ok(0);
    }
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

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

fn absolute_destination(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .context("output must name a file or directory")?;
    Ok(parent(path).canonicalize()?.join(name))
}

fn ensure_missing(path: &Path) -> Result<()> {
    match path.symlink_metadata() {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
        Ok(_) => anyhow::bail!("output already exists: {}", path.display()),
    }
}

pub fn check_pack_output(index: &Path, output: &Path) -> Result<PathBuf> {
    let index = match index.canonicalize() {
        Ok(path) => path,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => absolute_destination(index)?,
        Err(err) => return Err(err.into()),
    };
    let output = absolute_destination(output)?;
    ensure!(
        !output.starts_with(&index),
        "archive output must be outside the index"
    );
    ensure_missing(&output)?;
    Ok(output)
}

pub fn pack(index: &Path, output: &Path) -> Result<()> {
    let output = check_pack_output(index, output)?;
    let mut temporary = NamedTempFile::new_in(parent(&output))?;
    let mut archive = tar::Builder::new(zstd::Encoder::new(temporary.as_file_mut(), ZSTD_LEVEL)?);
    let mut entries = fs::read_dir(index)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if entry.file_type()?.is_file() && !entry.file_name().to_string_lossy().ends_with(".lock") {
            archive
                .append_path_with_name(entry.path(), Path::new("index").join(entry.file_name()))?;
        }
    }
    archive.into_inner()?.finish()?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(output)?;
    Ok(())
}
