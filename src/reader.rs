use std::{ops::Bound::Included, path::Path};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use tantivy::{
    DocAddress, Index, ReloadPolicy, Searcher, TantivyDocument, Term,
    collector::DocSetCollector,
    directory::MmapDirectory,
    query::{BooleanQuery, Occur, Query, RangeQuery, TermQuery},
    schema::{Field, IndexRecordOption, Schema, Value},
};

use crate::{
    directory::ReadOnlyDirectory,
    schema::{Kind, format_date, register},
    search::SNIPPET_MAX_BYTES,
};

pub struct Snapshot {
    pub(crate) searcher: Searcher,
    pub(crate) schema: Schema,
}

impl Snapshot {
    pub fn open(path: &Path) -> Result<Self> {
        let nested = path.join("index");
        let legacy = !nested.is_dir();
        let path = if legacy { path } else { &nested };
        let index = Index::open(ReadOnlyDirectory(MmapDirectory::open(path)?))?;
        register(&index);
        let schema = index.schema();
        for (name, entry) in crate::schema::schema().fields() {
            if legacy && entry.name() == "snippet_only" && schema.get_field(entry.name()).is_err() {
                continue;
            }
            let actual = schema.get_field(entry.name())?;
            ensure!(
                schema.get_field_entry(actual) == entry,
                "invalid index field {name:?}"
            );
        }
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        Ok(Self {
            searcher: reader.searcher(),
            schema,
        })
    }

    pub(crate) fn field(&self, name: &str) -> Field {
        self.schema.get_field(name).expect("validated schema")
    }

    pub(crate) fn document(&self, address: DocAddress) -> Result<TantivyDocument> {
        Ok(self.searcher.doc(address)?)
    }

    pub(crate) fn text<'a>(&self, doc: &'a TantivyDocument, name: &str) -> Result<&'a str> {
        doc.get_first(self.field(name))
            .and_then(|value| value.as_str())
            .with_context(|| format!("indexed passage is missing its stored {name}"))
    }

    fn number(&self, doc: &TantivyDocument, name: &str) -> Result<u64> {
        doc.get_first(self.field(name))
            .and_then(|value| value.as_u64())
            .with_context(|| format!("indexed passage is missing its stored {name}"))
    }

    pub(crate) fn info(&self, doc: &TantivyDocument) -> Result<Info> {
        let date = doc
            .get_first(self.field("date"))
            .and_then(|value| value.as_i64())
            .context("indexed passage is missing its stored date")?;
        let optional = |value| (value != u64::MAX).then_some(value);
        let start_sec = optional(self.number(doc, "start_sec")?);
        let end_sec = optional(self.number(doc, "end_sec")?);
        Ok(Info {
            doc_id: self.text(doc, "doc_id")?.into(),
            work_id: self.text(doc, "work_id")?.into(),
            source_id: self.text(doc, "source_id")?.into(),
            kind: self.text(doc, "kind")?.into(),
            quality: self.number(doc, "quality")?,
            date: format_date(date),
            time_range: (start_sec.is_some() || end_sec.is_some())
                .then_some(TimeRange { start_sec, end_sec }),
            title: self.text(doc, "title")?.into(),
            heading: self.text(doc, "heading")?.into(),
            origin_url: self.text(doc, "origin_url")?.into(),
            other_kinds: doc
                .get_all(self.field("other_kinds"))
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect(),
        })
    }

    pub(crate) fn exact(&self, name: &str, value: &str) -> Box<dyn Query> {
        Box::new(TermQuery::new(
            Term::from_field_text(self.field(name), value),
            IndexRecordOption::Basic,
        ))
    }

    pub(crate) fn number_range(&self, name: &str, start: u64, end: u64) -> Box<dyn Query> {
        let field = self.field(name);
        Box::new(RangeQuery::new(
            Included(Term::from_field_u64(field, start)),
            Included(Term::from_field_u64(field, end)),
        ))
    }

    fn matching(&self, query: &dyn Query) -> Result<Vec<TantivyDocument>> {
        self.searcher
            .search(query, &DocSetCollector)?
            .into_iter()
            .map(|address| self.document(address))
            .collect()
    }

    pub(crate) fn has_work(&self, work_id: &str) -> Result<bool> {
        Ok(self
            .searcher
            .search(&*self.exact("work_id", work_id), &tantivy::collector::Count)?
            != 0)
    }

    pub fn outline(&self, work_id: &str, kinds: &[Kind]) -> Result<Option<Outline>> {
        let docs = self.matching(&*self.exact("work_id", work_id))?;
        if docs.is_empty() {
            return Ok(None);
        }
        let mut entries = Vec::new();
        for doc in docs {
            let info = self.info(&doc)?;
            if !kinds.is_empty() && !kinds.iter().any(|kind| kind.as_str() == info.kind) {
                continue;
            }
            entries.push((
                Preview {
                    doc_id: info.doc_id,
                    source_id: info.source_id,
                    kind: info.kind,
                    ordinal: self.number(&doc, "ordinal")?,
                    heading: info.heading,
                    time_range: info.time_range,
                    preview: prefix(self.text(&doc, "body")?, 220).into(),
                },
                info.origin_url,
            ));
        }
        entries.sort_by(|(a, _), (b, _)| (&a.source_id, a.ordinal).cmp(&(&b.source_id, b.ordinal)));
        let mut sources: Vec<Source> = Vec::new();
        for (passage, origin_url) in &entries {
            if let Some(source) = sources.last_mut().filter(|source| {
                source.source_id == passage.source_id && source.kind == passage.kind
            }) {
                source.passages += 1;
            } else {
                sources.push(Source {
                    source_id: passage.source_id.clone(),
                    kind: passage.kind.clone(),
                    passages: 1,
                    origin_url: origin_url.clone(),
                });
            }
        }
        Ok(Some(Outline {
            work_id: work_id.into(),
            sources,
            passages: entries.into_iter().map(|(passage, _)| passage).collect(),
        }))
    }

    pub fn read_id(&self, doc_id: &str, context: u64) -> Result<Option<Reading>> {
        self.matching(&*self.exact("doc_id", doc_id))?
            .first()
            .map(|doc| self.reading(doc, context))
            .transpose()
    }

    pub fn read_range(
        &self,
        work_id: &str,
        start: u64,
        end: u64,
        context: u64,
    ) -> Result<Option<Vec<Reading>>> {
        if !self.has_work(work_id)? {
            return Ok(None);
        }
        let query = intersection([
            self.exact("work_id", work_id),
            self.number_range("start_sec", 0, end.min(u64::MAX - 1)),
            self.number_range("end_sec", start, u64::MAX - 1),
        ]);
        let mut readings = self
            .matching(&query)?
            .iter()
            .map(|doc| self.reading(doc, context))
            .collect::<Result<Vec<_>>>()?;
        readings.sort_by(|a, b| a.passage.key().cmp(&b.passage.key()));
        Ok(Some(readings))
    }

    fn passage(&self, doc: &TantivyDocument) -> Result<ReadPassage> {
        let info = self.info(doc)?;
        let quality_note = match info.quality {
            1 => "Document",
            2 => "Transcript or Q&A",
            3 => "Summary",
            4 => "Suspect passage. Verify against the original source.",
            _ => anyhow::bail!("invalid stored quality"),
        };
        let snippet_only = if self.schema.get_field("snippet_only").is_ok() {
            let mode = self.number(doc, "snippet_only")?;
            ensure!(mode <= 1, "invalid stored license mode");
            mode == 1
        } else {
            false
        };
        let body = self.text(doc, "body")?;
        Ok(ReadPassage {
            info,
            ordinal: self.number(doc, "ordinal")?,
            quality_note,
            license_mode: if snippet_only { "snippet_only" } else { "full" },
            body: if snippet_only {
                prefix(body, SNIPPET_MAX_BYTES)
            } else {
                body
            }
            .into(),
        })
    }

    fn reading(&self, doc: &TantivyDocument, context: u64) -> Result<Reading> {
        let passage = self.passage(doc)?;
        let mut before = Vec::new();
        let mut after = Vec::new();
        if context > 0 {
            let query = intersection([
                self.exact("source_id", &passage.info.source_id),
                self.number_range(
                    "ordinal",
                    passage.ordinal.saturating_sub(context),
                    passage.ordinal.saturating_add(context),
                ),
            ]);
            for doc in self.matching(&query)? {
                let ordinal = self.number(&doc, "ordinal")?;
                match ordinal.cmp(&passage.ordinal) {
                    std::cmp::Ordering::Less => before.push(self.passage(&doc)?),
                    std::cmp::Ordering::Greater => after.push(self.passage(&doc)?),
                    std::cmp::Ordering::Equal => (),
                }
            }
            before.sort_by_key(|entry| entry.ordinal);
            after.sort_by_key(|entry| entry.ordinal);
        }
        Ok(Reading {
            passage,
            before,
            after,
        })
    }
}

pub(crate) fn intersection(clauses: impl IntoIterator<Item = Box<dyn Query>>) -> BooleanQuery {
    BooleanQuery::new(
        clauses
            .into_iter()
            .map(|query| (Occur::Must, query))
            .collect(),
    )
}

pub(crate) fn prefix(text: &str, bytes: usize) -> &str {
    text[..text.floor_char_boundary(bytes)].trim()
}

#[derive(Serialize)]
pub struct TimeRange {
    start_sec: Option<u64>,
    end_sec: Option<u64>,
}

impl std::fmt::Display for TimeRange {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let clock = |second: Option<u64>| {
            second.map_or_else(
                || "…".into(),
                |sec| format!("{:02}:{:02}:{:02}", sec / 3600, sec / 60 % 60, sec % 60),
            )
        };
        write!(out, "{}–{}", clock(self.start_sec), clock(self.end_sec))
    }
}

#[derive(Serialize)]
pub struct Info {
    pub doc_id: String,
    pub work_id: String,
    pub source_id: String,
    pub kind: String,
    pub quality: u64,
    pub date: Option<String>,
    pub time_range: Option<TimeRange>,
    pub title: String,
    pub heading: String,
    pub origin_url: String,
    pub other_kinds: Vec<String>,
}

#[derive(Serialize)]
pub struct Outline {
    pub work_id: String,
    pub sources: Vec<Source>,
    pub passages: Vec<Preview>,
}

#[derive(Serialize)]
pub struct Source {
    pub source_id: String,
    pub kind: String,
    pub passages: usize,
    pub origin_url: String,
}

#[derive(Serialize)]
pub struct Preview {
    pub doc_id: String,
    pub source_id: String,
    pub kind: String,
    pub ordinal: u64,
    pub heading: String,
    pub time_range: Option<TimeRange>,
    pub preview: String,
}

#[derive(Serialize)]
pub struct Reading {
    pub passage: ReadPassage,
    pub before: Vec<ReadPassage>,
    pub after: Vec<ReadPassage>,
}

#[derive(Serialize)]
pub struct ReadPassage {
    #[serde(flatten)]
    pub info: Info,
    pub ordinal: u64,
    pub quality_note: &'static str,
    pub license_mode: &'static str,
    pub body: String,
}

impl ReadPassage {
    fn key(&self) -> (&str, u64) {
        (&self.info.source_id, self.ordinal)
    }
}
