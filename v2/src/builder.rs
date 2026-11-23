use std::{
    collections::{HashMap, HashSet},
    fs,
    io::BufRead,
    path::{Component, Path, PathBuf, absolute},
};

use anyhow::{Context, Result, ensure};
use tantivy::{Index, IndexWriter, TantivyDocument, indexer::NoMergePolicy};
use tempfile::{Builder, NamedTempFile};

use crate::{
    metadata::{Counts, Metadata},
    schema::{LicenseMode, Passage, ZSTD_LEVEL, parse_date, register, schema, settings},
    synonyms::Synonyms,
};

pub fn build(input: impl BufRead, output: &Path, threads: usize) -> Result<u64> {
    build_with_sidecars(input, output, threads, None, None)
}

pub fn build_with_sidecars(
    input: impl BufRead,
    output: &Path,
    threads: usize,
    meta: Option<&Path>,
    synonyms: Option<&Path>,
) -> Result<u64> {
    ensure!(
        (1..=16).contains(&threads),
        "expected 1 through 16 indexing threads"
    );
    let meta = meta.map(Metadata::load).transpose()?;
    let synonyms = synonyms
        .map(fs::read)
        .transpose()?
        .unwrap_or_else(|| b"[]".to_vec());
    Synonyms::parse(&synonyms)?;
    let output = absolute_destination(output)?;
    ensure_missing(&output)?;
    let temporary = Builder::new()
        .prefix(".clec-index-")
        .tempdir_in(parent(&output))?;
    let files = temporary.path().join("index");
    fs::create_dir(&files)?;
    let counts = build_index(input, &files, threads)?;
    let count = counts.passages;
    if let Some(meta) = &meta {
        ensure!(
            meta.counts == counts,
            "metadata counts do not match the built index: declared {:?}, built {counts:?}",
            meta.counts
        );
    }
    let metadata = meta.unwrap_or_else(|| Metadata::derived(counts));
    serde_json::to_writer_pretty(
        fs::File::create(temporary.path().join("meta.json"))?,
        &metadata,
    )?;
    fs::write(temporary.path().join("synonyms.json"), synonyms)?;
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

fn build_index(input: impl BufRead, output: &Path, threads: usize) -> Result<Counts> {
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
    let mut counts = Counts::default();
    let mut documents = HashSet::new();
    let mut works = HashSet::new();
    let mut sources = HashMap::new();
    for (line_no, line) in input.lines().enumerate() {
        let line_number = line_no + 1;
        let passage: Passage =
            serde_json::from_str(&line.with_context(|| format!("reading line {line_number}"))?)
                .with_context(|| format!("passage at line {line_number}"))?;
        ensure!(
            [
                &passage.doc_id,
                &passage.work_id,
                &passage.source_id,
                &passage.title,
                &passage.body
            ]
            .iter()
            .all(|value| !value.trim().is_empty()),
            "required text is empty at line {line_number}"
        );
        ensure!(
            documents.insert(passage.doc_id.clone()),
            "duplicate doc_id at line {line_number}: {}",
            passage.doc_id
        );
        works.insert(passage.work_id.clone());
        let next = sources.entry(passage.source_id.clone()).or_insert(0_u64);
        ensure!(
            passage.ordinal == *next,
            "expected ordinal {next} at line {line_number}, got {}",
            passage.ordinal
        );
        *next += 1;
        ensure!(
            (1..=4).contains(&passage.quality),
            "quality outside 1..=4 at line {line_number}"
        );
        ensure!(
            !passage.other_kinds.contains(&passage.kind),
            "other_kinds contains the passage's own kind at line {line_number}"
        );
        ensure!(
            !matches!(passage.start_sec.zip(passage.end_sec), Some((start, end)) if start > end)
                && passage.start_sec != Some(u64::MAX)
                && passage.end_sec != Some(u64::MAX),
            "invalid timestamp bounds at line {line_number}"
        );
        let date = passage
            .date
            .as_deref()
            .map(parse_date)
            .transpose()
            .with_context(|| format!("date at line {line_number}"))?
            .unwrap_or(0);
        *counts
            .by_kind
            .entry(passage.kind.as_str().into())
            .or_default() += 1;
        *counts
            .by_quality
            .entry(passage.quality.to_string())
            .or_default() += 1;
        if date != 0 {
            *counts
                .by_year
                .entry(format!("{:04}", date / 10000))
                .or_default() += 1;
        }
        let mut doc = TantivyDocument::new();
        for (name, value) in [
            ("doc_id", passage.doc_id),
            ("work_id", passage.work_id),
            ("source_id", passage.source_id),
            ("kind", passage.kind.as_str().to_owned()),
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
        doc.add_u64(
            field("snippet_only"),
            u64::from(passage.license_mode == LicenseMode::SnippetOnly),
        );
        doc.add_i64(field("date"), date);
        for kind in passage.other_kinds {
            doc.add_text(field("other_kinds"), kind.as_str());
        }
        writer
            .add_document(doc)
            .with_context(|| format!("indexing line {line_number}"))?;
        counts.passages += 1;
    }
    ensure!(counts.passages > 0, "expected at least one passage");
    counts.works = works.len();
    counts.sources = sources.len();
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
    Ok(counts)
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

fn lexical_absolute(path: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in absolute(path)?.components() {
        if component == Component::ParentDir {
            normalized.pop();
        } else {
            normalized.push(component);
        }
    }
    Ok(normalized)
}

pub fn check_pack_output(index: &Path, output: &Path) -> Result<PathBuf> {
    ensure!(
        !lexical_absolute(output)?.starts_with(lexical_absolute(index)?),
        "archive output must be outside the index"
    );
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
    append_files(&mut archive, index, Path::new("index"))?;
    archive.into_inner()?.finish()?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(output)?;
    Ok(())
}

fn append_files(
    archive: &mut tar::Builder<impl std::io::Write>,
    dir: &Path,
    prefix: &Path,
) -> Result<()> {
    let mut entries = fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name();
        let file_type = entry.file_type()?;
        if file_type.is_dir() && name == "index" && prefix == Path::new("index") {
            append_files(archive, &entry.path(), &prefix.join(name))?;
        } else if file_type.is_file() && !name.to_string_lossy().ends_with(".lock") {
            archive.append_path_with_name(entry.path(), prefix.join(name))?;
        }
    }
    Ok(())
}
