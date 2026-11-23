use std::{collections::BTreeMap, path::Path, time::Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use tantivy::{
    Index, ReloadPolicy, Searcher, TantivyDocument, Term,
    collector::TopDocs,
    directory::MmapDirectory,
    query::{BooleanQuery, BoostQuery, DisjunctionMaxQuery, Occur, Query, TermQuery},
    schema::{Field, IndexRecordOption, Schema, Value},
    snippet::SnippetGenerator,
};

use crate::{
    directory::ReadOnlyDirectory,
    schema::register,
    tokenizer::{StopWords, query_terms_with_stopwords},
};

pub const SNIPPET_MAX_BYTES: usize = 550;

pub struct Search {
    searcher: Searcher,
    id: Field,
    fields: [(Field, f32); 3],
}

#[derive(Serialize)]
pub struct Hit {
    doc_id: String,
    score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    snippet: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    highlights: Vec<String>,
}

#[derive(Default, Serialize)]
pub struct Timing {
    pub tokenize_ms: f64,
    pub bm25_ms: f64,
    pub docstore_ms: f64,
    pub snippets_ms: f64,
    pub total_ms: f64,
}

pub fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

impl Search {
    pub fn open(path: &Path) -> Result<Self> {
        let index = Index::open(ReadOnlyDirectory(MmapDirectory::open(path)?))?;
        register(&index);
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        Self::new(reader.searcher(), &index.schema())
    }

    fn new(searcher: Searcher, schema: &Schema) -> Result<Self> {
        Ok(Self {
            searcher,
            id: schema.get_field("doc_id")?,
            fields: [
                (schema.get_field("title")?, 3.0),
                (schema.get_field("heading")?, 2.0),
                (schema.get_field("body")?, 1.0),
            ],
        })
    }

    fn query(&self, terms: &[String]) -> BooleanQuery {
        let mut frequencies = BTreeMap::new();
        for term in terms {
            *frequencies.entry(term).or_insert(0_u32) += 1;
        }
        let clauses = frequencies
            .into_iter()
            .map(|(term, frequency)| {
                let fields = self
                    .fields
                    .iter()
                    .map(|&(field, boost)| {
                        Box::new(BoostQuery::new(
                            Box::new(TermQuery::new(
                                Term::from_field_text(field, term),
                                IndexRecordOption::WithFreqs,
                            )),
                            boost,
                        )) as Box<dyn Query>
                    })
                    .collect();
                let query = Box::new(DisjunctionMaxQuery::new(fields));
                (
                    Occur::Should,
                    Box::new(BoostQuery::new(query, frequency as f32)) as Box<dyn Query>,
                )
            })
            .collect();
        BooleanQuery::with_minimum_required_clauses(clauses, 1)
    }

    pub fn run(&self, text: &str, limit: usize, snippets: bool) -> Result<(Vec<Hit>, Timing)> {
        self.run_with_stopwords(text, limit, snippets, StopWords::DEFAULT)
    }

    pub fn run_with_stopwords(
        &self,
        text: &str,
        limit: usize,
        snippets: bool,
        stop_words: StopWords,
    ) -> Result<(Vec<Hit>, Timing)> {
        let started = Instant::now();
        let terms = query_terms_with_stopwords(text, stop_words);
        let mut timing = Timing {
            tokenize_ms: elapsed_ms(started),
            ..Timing::default()
        };
        if terms.is_empty() {
            timing.total_ms = elapsed_ms(started);
            return Ok((Vec::new(), timing));
        }
        let stage = Instant::now();
        let query = self.query(&terms);
        let hits = self.searcher.search(&query, &TopDocs::with_limit(limit))?;
        timing.bm25_ms = elapsed_ms(stage);
        let stage = Instant::now();
        let body = self.fields[2].0;
        let generator = if snippets {
            let mut generator = SnippetGenerator::create(&self.searcher, &query, body)?;
            // Tantivy measures the fragment limit using UTF-8 byte offsets.
            generator.set_max_num_chars(SNIPPET_MAX_BYTES);
            Some(generator)
        } else {
            None
        };
        timing.snippets_ms = elapsed_ms(stage);
        let results = hits
            .into_iter()
            .map(|(score, address)| {
                let stage = Instant::now();
                let doc: TantivyDocument = self.searcher.doc(address)?;
                timing.docstore_ms += elapsed_ms(stage);
                let doc_id = doc
                    .get_first(self.id)
                    .and_then(|value| value.as_str())
                    .context("indexed passage is missing its stored doc_id")?
                    .into();
                let (snippet, highlights) = generator.as_ref().map_or_else(
                    || (None, Vec::new()),
                    |generator| {
                        let stage = Instant::now();
                        let snippet = generator.snippet_from_doc(&doc);
                        let fragment = snippet.fragment();
                        let highlights = snippet
                            .highlighted()
                            .iter()
                            .map(|range| fragment[range.clone()].to_owned())
                            .collect();
                        timing.snippets_ms += elapsed_ms(stage);
                        (Some(fragment.into()), highlights)
                    },
                );
                Ok(Hit {
                    doc_id,
                    score,
                    snippet,
                    highlights,
                })
            })
            .collect::<Result<_>>()?;
        timing.total_ms = elapsed_ms(started);
        Ok((results, timing))
    }
}
