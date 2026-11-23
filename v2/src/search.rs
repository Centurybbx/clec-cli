use std::{
    collections::{BTreeMap, HashMap},
    ops::Bound::Included,
    path::Path,
};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use tantivy::{
    DocAddress, TantivyDocument, Term,
    collector::TopDocs,
    query::{
        BooleanQuery, BoostQuery, ConstScoreQuery, DisjunctionMaxQuery, Occur, Query, RangeQuery,
        TermQuery,
    },
    schema::IndexRecordOption,
    snippet::SnippetGenerator,
};

use crate::{
    reader::{Info, Snapshot, intersection, prefix},
    schema::Kind,
    synonyms::Synonyms,
    tokenizer::query_terms,
};

pub const SNIPPET_MAX_BYTES: usize = 550;
const ROUTE_LIMIT: usize = 100;

type RankedRoute = (BooleanQuery, Vec<(f32, DocAddress)>);

pub struct Search {
    index: Snapshot,
    synonyms: Synonyms,
}

pub struct Options<'a> {
    pub kinds: &'a [Kind],
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub work: Option<&'a str>,
    pub limit: usize,
    pub offset: usize,
    pub per_work: usize,
    pub exclude_suspect: bool,
}

#[derive(Serialize)]
pub struct Page {
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
    pub hits: Vec<SearchHit>,
}

#[derive(Serialize)]
pub struct SearchHit {
    #[serde(flatten)]
    pub info: Info,
    pub snippet: String,
    pub highlights: Vec<String>,
    pub snippet_field: &'static str,
    pub score: f64,
}

struct Candidate {
    address: DocAddress,
    score: f64,
    work: (u32, u64),
}

impl Search {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            index: Snapshot::open(path)?,
            synonyms: Synonyms::load(path)?,
        })
    }

    pub fn has_work(&self, work_id: &str) -> Result<bool> {
        self.index.has_work(work_id)
    }

    fn term(&self, term: &str) -> Box<dyn Query> {
        let fields = [("title", 3.0), ("heading", 2.0), ("body", 1.0)]
            .into_iter()
            .map(|(name, boost)| {
                let term = Term::from_field_text(self.index.field(name), term);
                Box::new(BoostQuery::new(
                    Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs)),
                    boost,
                )) as Box<dyn Query>
            })
            .collect();
        Box::new(DisjunctionMaxQuery::new(fields))
    }

    fn query(&self, text: &str, terms: &[String]) -> BooleanQuery {
        let mut frequencies = BTreeMap::new();
        for term in terms {
            *frequencies.entry(term).or_insert(0_u32) += 1;
        }
        let expansions = self.synonyms.expand(text, terms);
        let clauses = frequencies
            .into_iter()
            .map(|(term, frequency)| {
                let mut alternatives = vec![self.term(term)];
                for (_, aliases) in expansions.iter().filter(|(anchor, _)| anchor == term) {
                    for alias in aliases {
                        let query: Box<dyn Query> = if let [word] = alias.as_slice() {
                            self.term(word)
                        } else {
                            let weight = 1.0 / alias.len() as f32;
                            Box::new(BoostQuery::new(
                                Box::new(intersection(alias.iter().map(|word| self.term(word)))),
                                weight,
                            ))
                        };
                        alternatives.push(Box::new(BoostQuery::new(query, 0.5)));
                    }
                }
                let group = Box::new(DisjunctionMaxQuery::new(alternatives));
                (
                    Occur::Should,
                    Box::new(BoostQuery::new(group, frequency as f32)) as Box<dyn Query>,
                )
            })
            .collect();
        BooleanQuery::with_minimum_required_clauses(clauses, 1)
    }

    fn filtered(&self, query: BooleanQuery, options: &Options<'_>) -> Box<dyn Query> {
        let mut filters = Vec::<Box<dyn Query>>::new();
        if let Some(work) = options.work {
            filters.push(self.index.exact("work_id", work));
        }
        if !options.kinds.is_empty() {
            filters.push(Box::new(BooleanQuery::new(
                options
                    .kinds
                    .iter()
                    .map(|kind| (Occur::Should, self.index.exact("kind", kind.as_str())))
                    .collect(),
            )));
        }
        if options.from.is_some() || options.to.is_some() {
            let field = self.index.field("date");
            let from = Term::from_field_i64(field, options.from.unwrap_or(1));
            let to = Term::from_field_i64(field, options.to.unwrap_or(99_991_231));
            filters.push(Box::new(RangeQuery::new(Included(from), Included(to))));
        }
        if options.exclude_suspect {
            filters.push(self.index.number_range("quality", 1, 3));
        }
        if filters.is_empty() {
            return Box::new(query);
        }
        let filters = filters
            .into_iter()
            .map(|filter| Box::new(ConstScoreQuery::new(filter, 0.0)) as Box<dyn Query>);
        Box::new(intersection(
            std::iter::once(Box::new(query) as Box<dyn Query>).chain(filters),
        ))
    }

    fn rank_route(&self, text: &str, options: &Options<'_>) -> Result<RankedRoute> {
        let terms = query_terms(text);
        ensure!(!terms.is_empty(), "query must contain a searchable term");
        let query = self.query(text, &terms);
        let filtered = self.filtered(query.clone(), options);
        let hits = self
            .index
            .searcher
            .search(&*filtered, &TopDocs::with_limit(ROUTE_LIMIT))?;
        Ok((query, hits))
    }

    pub fn page(&self, routes: &[String], options: &Options<'_>, snippets: bool) -> Result<Page> {
        ensure!(
            (1..=4).contains(&routes.len()),
            "expected one to four queries"
        );
        let ranked = std::thread::scope(|scope| {
            let jobs: Vec<_> = routes[1..]
                .iter()
                .map(|text| scope.spawn(move || self.rank_route(text, options)))
                .collect();
            let mut ranked = vec![self.rank_route(&routes[0], options)];
            for job in jobs {
                ranked.push(
                    job.join()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("query worker panicked"))),
                );
            }
            ranked
        });
        let mut fused = BTreeMap::<DocAddress, f64>::new();
        let mut queries = Vec::<Box<dyn Query>>::new();
        for route in ranked {
            let (query, hits) = route?;
            for (rank, (_, address)) in hits.into_iter().enumerate() {
                *fused.entry(address).or_default() += 1.0 / (61.0 + rank as f64);
            }
            queries.push(Box::new(query));
        }

        let total = fused.len();
        let mut candidates = Vec::with_capacity(total);
        for (segment, reader) in self.index.searcher.segment_readers().iter().enumerate() {
            let fast = reader.fast_fields();
            let works = fast.str("work_id")?.context("missing work_id fast field")?;
            let qualities = fast.u64("quality")?;
            let segment = segment as u32;
            for (&address, &score) in
                fused.range(DocAddress::new(segment, 0)..=DocAddress::new(segment, u32::MAX))
            {
                let work = works
                    .term_ords(address.doc_id)
                    .next()
                    .context("missing work_id")?;
                let quality = match qualities.first(address.doc_id) {
                    Some(1) => 1.15,
                    Some(2) => 1.05,
                    Some(3) => 0.85,
                    Some(4) => 0.40,
                    _ => anyhow::bail!("invalid indexed quality"),
                };
                candidates.push(Candidate {
                    address,
                    score: score * quality,
                    work: (segment, work),
                });
            }
        }
        if self.index.searcher.segment_readers().len() > 1 {
            // Legacy snapshots can use a different dictionary ordinal for each segment.
            let mut works = HashMap::new();
            for candidate in &mut candidates {
                let doc = self.index.document(candidate.address)?;
                let work = self.index.text(&doc, "work_id")?;
                let next = works.len() as u64;
                candidate.work = (0, *works.entry(work.to_owned()).or_insert(next));
            }
        }
        candidates
            .sort_unstable_by(|a, b| b.score.total_cmp(&a.score).then(a.address.cmp(&b.address)));
        let mut works = HashMap::new();
        let (head, tail): (Vec<_>, Vec<_>) = candidates.into_iter().partition(|candidate| {
            let count = works.entry(candidate.work).or_insert(0);
            *count += 1;
            *count <= options.per_work
        });
        let union = BooleanQuery::new(
            queries
                .into_iter()
                .map(|query| (Occur::Should, query))
                .collect(),
        );
        let generator = (snippets && options.offset < total)
            .then(|| self.generator(&union, "body"))
            .transpose()?;
        let mut fallback = None;
        let hits = head
            .into_iter()
            .chain(tail)
            .skip(options.offset)
            .take(options.limit)
            .map(|candidate| {
                let doc = self.index.document(candidate.address)?;
                let (mut snippet, mut highlights) = self.excerpt(generator.as_ref(), &doc)?;
                let mut snippet_field = "body";
                if snippets && highlights.is_empty() {
                    let alternatives = match &mut fallback {
                        Some(alternatives) => alternatives,
                        slot => slot.insert([
                            self.generator(&union, "heading")?,
                            self.generator(&union, "title")?,
                        ]),
                    };
                    for (field, generator) in ["heading", "title"].into_iter().zip(alternatives) {
                        let match_ = generator.snippet_from_doc(&doc);
                        if !match_.is_empty() {
                            (snippet, highlights) = fragment(&match_);
                            snippet_field = field;
                            break;
                        }
                    }
                }
                Ok(SearchHit {
                    info: self.index.info(&doc)?,
                    snippet,
                    highlights,
                    snippet_field,
                    score: candidate.score,
                })
            })
            .collect::<Result<_>>()?;
        Ok(Page {
            total,
            offset: options.offset,
            limit: options.limit,
            has_more: options.offset.saturating_add(options.limit) < total,
            hits,
        })
    }

    fn generator(&self, query: &dyn Query, field: &str) -> Result<SnippetGenerator> {
        let mut generator =
            SnippetGenerator::create(&self.index.searcher, query, self.index.field(field))?;
        generator.set_max_num_chars(SNIPPET_MAX_BYTES);
        Ok(generator)
    }

    fn excerpt(
        &self,
        generator: Option<&SnippetGenerator>,
        doc: &TantivyDocument,
    ) -> Result<(String, Vec<String>)> {
        let Some(generator) = generator else {
            return Ok((String::new(), Vec::new()));
        };
        let snippet = generator.snippet_from_doc(doc);
        if snippet.is_empty() {
            return Ok((
                prefix(self.index.text(doc, "body")?, SNIPPET_MAX_BYTES).to_owned(),
                Vec::new(),
            ));
        }
        Ok(fragment(&snippet))
    }
}

fn fragment(snippet: &tantivy::snippet::Snippet) -> (String, Vec<String>) {
    let text = snippet.fragment();
    let fragment = text[..text.floor_char_boundary(SNIPPET_MAX_BYTES)].trim_end();
    let highlights = snippet
        .highlighted()
        .iter()
        .filter_map(|range| fragment.get(range.clone()).map(str::to_owned))
        .collect();
    (fragment.to_owned(), highlights)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{register, schema};
    use tantivy::{Index, doc};

    #[test]
    fn fragment_preserves_highlight_offsets_and_drops_truncated_ranges() -> Result<()> {
        let schema = schema();
        let body = schema.get_field("body")?;
        let index = Index::create_in_ram(schema);
        register(&index);
        let mut writer = index.writer(20_000_000)?;
        let text = format!(" \u{3000}繁體 {}繁體", " ".repeat(SNIPPET_MAX_BYTES - 13));
        writer.add_document(doc!(body => text.as_str()))?;
        writer.commit()?;
        let searcher = index.reader()?.searcher();
        let query = TermQuery::new(
            Term::from_field_text(body, "繁体"),
            IndexRecordOption::Basic,
        );
        let mut generator = SnippetGenerator::create(&searcher, &query, body)?;
        generator.set_max_num_chars(text.len());
        let snippet = generator.snippet(&text);
        assert_eq!(snippet.highlighted(), &[4..10, 548..554]);
        assert_eq!(
            fragment(&snippet),
            (" \u{3000}繁體".into(), vec!["繁體".into()])
        );
        Ok(())
    }
}
