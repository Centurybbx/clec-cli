use std::collections::{BTreeMap, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::domain::ByteSpan;
use crate::domain::{
    Attribution, ClecError, DateYmd, ErrorCode, PassageId, ReleaseHash, SourceId, SourceRole,
    WorkId,
};
use crate::ingest::SubtitleCue;
use crate::lexical::{Normalization, encode_fts_token};
use crate::store::{CandidateFilter, CorpusStore, SourceRecord, WorkRecord};

pub(crate) const MAX_QUERIES: usize = 4;
pub(crate) const TOP_PER_QUERY: usize = 200;
pub(crate) const DEDUP_WINDOW: usize = 200;
const NEAR_DUP_SHINGLE_N: usize = 4;
const NEAR_DUP_MIN_SHINGLES: usize = 32;
const NEAR_DUP_CONTAINMENT_PCT: usize = 60;
pub(crate) const DEFAULT_SEARCH_LIMIT: usize = 20;
pub(crate) const MAX_SEARCH_LIMIT: usize = 50;
const MAX_PER_WORK: usize = 5;
pub(crate) const DEFAULT_PER_WORK: usize = 2;
pub(crate) const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MatchMode {
    Any,
    All,
}

#[derive(Debug, Clone)]
pub(crate) struct SearchRequest {
    pub queries: Vec<String>,
    pub match_mode: MatchMode,
    pub limit: usize,
    pub offset: usize,
    pub per_work: usize,
    pub work_filter: Option<WorkId>,
    pub source_filter: Option<SourceId>,
    pub role_filter: Option<SourceRole>,
    pub date_from: Option<DateYmd>,
    pub date_to: Option<DateYmd>,
    pub release_pin: Option<ReleaseHash>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchHit {
    pub passage_id: PassageId,
    pub work: WorkRecord,
    pub source: SourceRecord,
    pub ordinal: usize,
    pub spans: Vec<ByteSpan>,
    pub cues: Vec<SubtitleCue>,
    pub diagnostics: Vec<String>,
    pub previous: Option<PassageId>,
    pub next: Option<PassageId>,
    pub continued_from: Option<PassageId>,
    pub continued_to: Option<PassageId>,
    pub text: String,
    pub rrf_score: f64,
    pub matched_queries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchLead {
    pub passage_id: PassageId,
    pub work: SearchWork,
    pub source: SearchSource,
    pub excerpt: String,
    pub excerpt_span: ByteSpan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_range: Option<SubtitleTimeRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continued_from: Option<PassageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continued_to: Option<PassageId>,
    pub rrf_score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchWork {
    pub work_id: WorkId,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub work_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchSource {
    pub source_id: SourceId,
    pub title: String,
    pub role: SourceRole,
    pub attribution: Attribution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<DateYmd>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_basis: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleTimeRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

pub(crate) struct LeadPassage<'a> {
    pub passage_id: PassageId,
    pub work: &'a WorkRecord,
    pub source: &'a SourceRecord,
    pub text: &'a str,
    pub spans: &'a [ByteSpan],
    pub time_range: Option<(u64, u64)>,
    pub continued_from: Option<PassageId>,
    pub continued_to: Option<PassageId>,
    pub rrf_score: Option<f64>,
}

// Count JSON escapes as well as UTF-8 bytes, even for the text CLI projection.
pub(crate) fn json_prefix(text: &str, budget: usize) -> &str {
    let mut used = 0;
    for (offset, ch) in text.char_indices() {
        used += match ch {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{08}' | '\u{0c}' => 2,
            '\u{00}'..='\u{1f}' => 6,
            _ => ch.len_utf8(),
        };
        if used > budget {
            return &text[..offset];
        }
    }
    text
}

pub(crate) fn project_lead(
    passage: LeadPassage<'_>,
    queries: &[SearchQueryTerms],
    normalization: Normalization,
) -> Result<SearchLead, ClecError> {
    let mut offset = 0;
    let mut fallback = None;
    let mut selected = None;
    // Stored passage text joins original spans with a synthetic newline. An excerpt
    // stays within a single span so its bytes come from one contiguous source range.
    for span in passage.spans {
        let length = span.end_byte() - span.start_byte();
        let piece = passage.text.get(offset..offset + length).ok_or_else(|| {
            ClecError::new(
                ErrorCode::IntegrityMismatch,
                "Invalid passage span in search.",
            )
        })?;
        offset += length + 1;
        let mut sentence_offset = 0;
        for sentence in piece.split_inclusive(['。', '！', '？', '\n']) {
            let start = sentence_offset + sentence.len() - sentence.trim_start().len();
            sentence_offset += sentence.len();
            let sentence = sentence.trim();
            if sentence.is_empty() {
                continue;
            }
            let normalized = normalization.normalize(sentence);
            let candidate = (span, start, sentence);
            fallback.get_or_insert(candidate);
            if queries
                .iter()
                .any(|q| q.terms.iter().any(|term| normalized.contains(term)))
            {
                selected = Some(candidate);
                break;
            }
        }
        if selected.is_some() {
            break;
        }
    }
    let (span, start, sentence) = selected.or(fallback).ok_or_else(|| {
        ClecError::new(
            ErrorCode::IntegrityMismatch,
            "Search passage has no excerpt text.",
        )
    })?;
    let literal_match = queries
        .iter()
        .flat_map(|q| &q.terms)
        .filter_map(|term| sentence.find(term))
        .min();
    let window = literal_match.map_or(0, |at| {
        sentence[..at]
            .char_indices()
            .rev()
            .nth(16)
            .map_or(0, |(index, _)| index)
    });
    let excerpt = json_prefix(&sentence[window..], 384);
    let start = span.start_byte() + start + window;
    let excerpt_span = ByteSpan::new(start, start + excerpt.len(), span.cue_ordinal())?;
    Ok(SearchLead {
        passage_id: passage.passage_id,
        work: SearchWork {
            work_id: passage.work.work_id.clone(),
            work_key: if json_prefix(&passage.work.work_key, 72) == passage.work.work_key {
                passage.work.work_key.clone()
            } else {
                String::new()
            },
            family_key: passage
                .work
                .family
                .as_ref()
                .map(|family| family.key.clone()),
        },
        source: SearchSource {
            source_id: passage.source.source_id.clone(),
            title: json_prefix(&passage.source.title, 144).to_owned(),
            role: passage.source.role,
            attribution: passage.source.attribution,
            date: passage.source.date.clone(),
            date_basis: passage
                .source
                .date_basis
                .as_deref()
                .map(|value| json_prefix(value, 32).to_owned()),
        },
        excerpt: excerpt.to_owned(),
        excerpt_span,
        time_range: passage
            .time_range
            .map(|(start_ms, end_ms)| SubtitleTimeRange { start_ms, end_ms }),
        continued_from: passage.continued_from,
        continued_to: passage.continued_to,
        rrf_score: passage.rrf_score,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BudgetReport {
    pub max_bytes: usize,
    pub used_bytes: usize,
    pub omitted_count: usize,
    pub omitted_ids: Vec<PassageId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchQueryTerms {
    pub query: String,
    pub terms: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchData<H = SearchLead> {
    pub release: ReleaseHash,
    pub match_mode: MatchMode,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub queries: Vec<SearchQueryTerms>,
    pub total_candidates: usize,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
    pub hits: Vec<H>,
    pub budget: BudgetReport,
}

#[derive(Debug, Clone)]
pub(crate) struct RankedCandidate {
    pub passage_id: PassageId,
    pub work_id: WorkId,
    pub rrf_score: f64,
    pub best_rank: usize,
    pub matched_queries: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedSearch {
    pub normalization: Normalization,
    pub queries: Vec<SearchQueryTerms>,
    pub match_mode: MatchMode,
    pub limit: usize,
    pub offset: usize,
    pub per_work: usize,
    pub work_filter: Option<WorkId>,
    pub source_filter: Option<SourceId>,
    pub role_filter: Option<SourceRole>,
    pub date_from: Option<DateYmd>,
    pub date_to: Option<DateYmd>,
    pub release_pin: Option<ReleaseHash>,
}

impl PreparedSearch {
    pub(crate) fn prepare(req: SearchRequest) -> Result<Self, ClecError> {
        if req.queries.is_empty() || req.queries.len() > MAX_QUERIES {
            return Err(ClecError::new(
                ErrorCode::InvalidQuery,
                format!("Search requires 1..={MAX_QUERIES} queries."),
            ));
        }
        if req.limit == 0 || req.limit > MAX_SEARCH_LIMIT {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                format!("--limit must be 1..={MAX_SEARCH_LIMIT}."),
            ));
        }
        if req.per_work == 0 || req.per_work > MAX_PER_WORK {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                format!("--per-work must be 1..={MAX_PER_WORK}."),
            ));
        }
        if let (Some(from), Some(to)) = (&req.date_from, &req.date_to)
            && from > to
        {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "--date-from must be <= --date-to.",
            ));
        }

        let mut parsed_queries = Vec::with_capacity(req.queries.len());
        for q in req.queries {
            let terms = Normalization::Current.query_terms(&q)?;
            parsed_queries.push(SearchQueryTerms { query: q, terms });
        }

        Ok(Self {
            normalization: Normalization::Current,
            queries: parsed_queries,
            match_mode: req.match_mode,
            limit: req.limit,
            offset: req.offset,
            per_work: req.per_work,
            work_filter: req.work_filter,
            source_filter: req.source_filter,
            role_filter: req.role_filter,
            date_from: req.date_from,
            date_to: req.date_to,
            release_pin: req.release_pin,
        })
    }
    pub(crate) fn bind_normalization(
        &mut self,
        normalization: Normalization,
    ) -> Result<(), ClecError> {
        if self.normalization != normalization {
            for query in &mut self.queries {
                query.terms = normalization.query_terms(&query.query)?;
            }
            self.normalization = normalization;
        }
        Ok(())
    }
}

pub(crate) fn collect_rrf_candidates(
    store: &CorpusStore,
    req: &PreparedSearch,
) -> Result<Vec<RankedCandidate>, ClecError> {
    if let Some(pin) = &req.release_pin
        && pin != &store.release
    {
        return Err(ClecError::new(
            ErrorCode::VersionUnavailable,
            "Active release differs from requested --release.",
        ));
    }

    let join_op = match req.match_mode {
        MatchMode::Any => " OR ",
        MatchMode::All => " AND ",
    };

    let filter = CandidateFilter {
        work_filter: req.work_filter.as_ref(),
        source_filter: req.source_filter.as_ref(),
        role_filter: req.role_filter,
        date_from: req.date_from.as_ref(),
        date_to: req.date_to.as_ref(),
    };

    let mut fused: BTreeMap<PassageId, RankedCandidate> = BTreeMap::new();

    for pq in &req.queries {
        let fts_query = pq
            .terms
            .iter()
            .map(|t| format!("\"{}\"", encode_fts_token(t)))
            .collect::<Vec<_>>()
            .join(join_op);

        let candidates = store.query_bm25_candidates(&fts_query, &filter, TOP_PER_QUERY)?;
        for (rank, cand) in candidates.into_iter().enumerate() {
            let contribution = 1.0 / (RRF_K + (rank as f64 + 1.0));
            let entry = fused
                .entry(cand.passage_id.clone())
                .or_insert_with(|| RankedCandidate {
                    passage_id: cand.passage_id,
                    work_id: cand.work_id,
                    rrf_score: 0.0,
                    best_rank: rank,
                    matched_queries: Vec::new(),
                });
            entry.rrf_score += contribution;
            if rank < entry.best_rank {
                entry.best_rank = rank;
            }
            if !entry.matched_queries.contains(&pq.query) {
                entry.matched_queries.push(pq.query.clone());
            }
        }
    }

    let mut ranked: Vec<RankedCandidate> = fused.into_values().collect();
    ranked.sort_by(|a, b| {
        b.rrf_score
            .total_cmp(&a.rrf_score)
            .then_with(|| a.best_rank.cmp(&b.best_rank))
            .then_with(|| a.passage_id.cmp(&b.passage_id))
    });
    Ok(ranked)
}

pub(crate) fn materialize_passage_hit(
    store: &CorpusStore,
    passage_id: &PassageId,
    rrf_score: f64,
    matched_queries: Vec<String>,
) -> Result<SearchHit, ClecError> {
    let item = store.read_passage(passage_id, 0, None)?;
    Ok(SearchHit {
        passage_id: item.passage_id,
        work: item.work,
        source: item.source,
        ordinal: item.ordinal,
        spans: item.spans,
        cues: item.cues,
        diagnostics: item.diagnostics,
        previous: item.previous,
        next: item.next,
        continued_from: item.continued_from,
        continued_to: item.continued_to,
        text: item.text,
        rrf_score,
        matched_queries,
    })
}

pub(crate) fn execute_search(
    store: &CorpusStore,
    req: &PreparedSearch,
) -> Result<SearchData, ClecError> {
    let ranked = collect_rrf_candidates(store, req)?;
    let total_candidates = ranked.len();
    let enable_dedup = req.work_filter.is_none() && req.source_filter.is_none();
    let ordered_indices = diversify_ranked_candidates(
        store,
        req.normalization,
        &ranked,
        req.per_work,
        enable_dedup,
    )?;
    let selected_indices: Vec<usize> = ordered_indices
        .into_iter()
        .skip(req.offset)
        .take(req.limit)
        .collect();

    let mut hits = Vec::with_capacity(selected_indices.len());
    for idx in selected_indices {
        let candidate = &ranked[idx];
        let passage = store.load_search_passage(&candidate.passage_id)?;
        let lead = project_lead(
            LeadPassage {
                passage_id: candidate.passage_id.clone(),
                work: &passage.work,
                source: &passage.source,
                text: &passage.text,
                spans: &passage.spans,
                time_range: passage.time_range,
                continued_from: passage.continued_from,
                continued_to: passage.continued_to,
                rrf_score: Some(candidate.rrf_score),
            },
            &req.queries,
            req.normalization,
        )?;
        store.verify_search_excerpt(
            &passage.source.content_hash,
            &lead.excerpt_span,
            &lead.excerpt,
        )?;
        hits.push(lead);
    }

    let returned_end = req.offset.saturating_add(hits.len());
    let has_more = returned_end < total_candidates;
    let next_offset = has_more.then_some(returned_end);

    Ok(SearchData {
        release: store.release.clone(),
        match_mode: req.match_mode,
        queries: req.queries.clone(),
        total_candidates,
        offset: req.offset,
        limit: req.limit,
        has_more,
        next_offset,
        hits,
        budget: BudgetReport {
            max_bytes: 0,
            used_bytes: 0,
            omitted_count: 0,
            omitted_ids: Vec::new(),
        },
    })
}

pub(crate) fn apply_work_diversity_indices<T, F>(
    ranked: &[T],
    limit: usize,
    per_work: usize,
    work_of: F,
) -> Vec<usize>
where
    F: Fn(&T) -> &WorkId,
{
    let mut selected = Vec::with_capacity(limit.min(ranked.len()));
    let mut used_indices = vec![false; ranked.len()];
    let mut work_counts: HashMap<&str, usize> = HashMap::new();

    for (idx, candidate) in ranked.iter().enumerate() {
        if selected.len() == limit {
            break;
        }
        let count = work_counts.entry(work_of(candidate).as_str()).or_insert(0);
        if *count < per_work {
            *count += 1;
            used_indices[idx] = true;
            selected.push(idx);
        }
    }

    if selected.len() < limit {
        for (idx, used) in used_indices.iter().enumerate() {
            if selected.len() == limit {
                break;
            }
            if !used {
                selected.push(idx);
            }
        }
    }

    selected
}

/// Extract sorted, deduplicated 64-bit FNV-1a 4-gram shingle hashes from normalized text.
pub(crate) fn passage_shingles(normalization: Normalization, text: &str) -> Vec<u64> {
    let normalized = normalization.normalize(text);
    let chars: Vec<char> = normalized
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect();
    if chars.len() < NEAR_DUP_SHINGLE_N {
        return Vec::new();
    }
    let mut hashes = Vec::with_capacity(chars.len() - NEAR_DUP_SHINGLE_N + 1);
    for win in chars.windows(NEAR_DUP_SHINGLE_N) {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &ch in win {
            for b in (ch as u32).to_le_bytes() {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        }
        hashes.push(h);
    }
    hashes.sort_unstable();
    hashes.dedup();
    hashes
}

/// Return true when two passages share >= 60% of the smaller passage's unique 4-grams.
/// Low-entropy or very short passages (< 32 unique 4-grams) are never collapsed.
pub(crate) fn is_near_duplicate(a: &[u64], b: &[u64]) -> bool {
    let min_len = a.len().min(b.len());
    if min_len < NEAR_DUP_MIN_SHINGLES {
        return false;
    }
    let threshold = (min_len * NEAR_DUP_CONTAINMENT_PCT).div_ceil(100);
    let (mut ia, mut ib, mut inter) = (0usize, 0usize, 0usize);
    while ia < a.len() && ib < b.len() {
        let va = a[ia];
        let vb = b[ib];
        match va.cmp(&vb) {
            std::cmp::Ordering::Less => ia += 1,
            std::cmp::Ordering::Greater => ib += 1,
            std::cmp::Ordering::Equal => {
                inter += 1;
                if inter >= threshold {
                    return true;
                }
                ia += 1;
                ib += 1;
            }
        }
        let rem = (a.len() - ia).min(b.len() - ib);
        if inter + rem < threshold {
            return false;
        }
    }
    false
}

fn witness_priority(role: SourceRole, attribution: Attribution, has_family: bool) -> u8 {
    match role {
        SourceRole::Document => {
            if has_family || attribution == Attribution::PublisherVerified {
                5
            } else {
                4
            }
        }
        SourceRole::Transcript => match attribution {
            Attribution::PublisherVerified
            | Attribution::AuthoredFixture
            | Attribution::AutomaticUnverified => 4,
            Attribution::UnverifiedTranscript
            | Attribution::MachineUnverified
            | Attribution::OriginalUnknown => 2,
        },
        SourceRole::Qa => 3,
        SourceRole::Summary => 1,
    }
}

struct DedupCluster {
    winner_idx: usize,
    winner_priority: u8,
    shingles: Vec<u64>,
}

/// Collapse near-duplicate editions across `work_id`s within the top `DEDUP_WINDOW`
/// while upgrading each duplicate cluster to its cleanest witness representation,
/// then apply `per_work` limits and backfill demoted items into the tail for pagination.
pub(crate) fn diversify_ranked_candidates(
    store: &CorpusStore,
    normalization: Normalization,
    ranked: &[RankedCandidate],
    per_work: usize,
    enable_dedup: bool,
) -> Result<Vec<usize>, ClecError> {
    if !enable_dedup || ranked.len() <= 1 {
        return Ok(apply_work_diversity_indices(
            ranked,
            ranked.len(),
            per_work,
            |c| &c.work_id,
        ));
    }

    let win = ranked.len().min(DEDUP_WINDOW);
    let mut clusters: Vec<DedupCluster> = Vec::with_capacity(win);
    for (idx, cand) in ranked[..win].iter().enumerate() {
        let info = store.load_passage_dedup_info(&cand.passage_id)?;
        let shingles = passage_shingles(normalization, &info.text);
        let priority = witness_priority(info.role, info.attribution, info.has_family);
        if let Some(cluster) = clusters
            .iter_mut()
            .find(|cl| is_near_duplicate(&shingles, &cl.shingles))
        {
            if priority > cluster.winner_priority {
                cluster.winner_idx = idx;
                cluster.winner_priority = priority;
                cluster.shingles = shingles;
            }
        } else {
            clusters.push(DedupCluster {
                winner_idx: idx,
                winner_priority: priority,
                shingles,
            });
        }
    }

    let mut selected = Vec::with_capacity(ranked.len());
    let mut used = vec![false; ranked.len()];
    let mut work_counts: HashMap<&str, usize> = HashMap::new();

    for cluster in &clusters {
        let count = work_counts
            .entry(ranked[cluster.winner_idx].work_id.as_str())
            .or_insert(0);
        if *count < per_work {
            *count += 1;
            used[cluster.winner_idx] = true;
            selected.push(cluster.winner_idx);
        }
    }

    for idx in win..ranked.len() {
        let count = work_counts.entry(ranked[idx].work_id.as_str()).or_insert(0);
        if *count < per_work {
            *count += 1;
            used[idx] = true;
            selected.push(idx);
        }
    }

    for (idx, was_used) in used.iter().enumerate() {
        if !was_used {
            selected.push(idx);
        }
    }

    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        Attribution, ByteSpan, CORPUS_FORMAT, DICTIONARY_REVISION, EQUIVALENCE_REVISION,
        NORMALIZATION_REVISION, SEGMENTATION_REVISION, TOKENIZATION_REVISION, sha256_hex,
    };
    use crate::lexical::index_tokens_string;
    use crate::store::{CorpusCounts, SCHEMA_SQL};
    use rusqlite::{Connection, params};

    fn build_test_store(
        docs: &[(&str, &str, &str, &str, Option<&str>)],
    ) -> (tempfile::TempDir, CorpusStore) {
        let rich: Vec<_> = docs
            .iter()
            .map(|&(w, t, p, text, date)| {
                (
                    w,
                    t,
                    p,
                    SourceRole::Document,
                    Attribution::AuthoredFixture,
                    false,
                    text,
                    date,
                )
            })
            .collect();
        build_rich_test_store(&rich)
    }

    type RichDoc<'a> = (
        &'a str,
        &'a str,
        &'a str,
        SourceRole,
        Attribution,
        bool,
        &'a str,
        Option<&'a str>,
    );

    fn build_rich_test_store(docs: &[RichDoc<'_>]) -> (tempfile::TempDir, CorpusStore) {
        use crate::store::WorkFamily;
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("corpus.sqlite");
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

        let mut counts = CorpusCounts {
            works: 0,
            sources: 0,
            canonical_sources: 0,
            blobs: 0,
            passages: 0,
            cues: 0,
            inventory: 0,
        };
        let mut seen_works = HashMap::new();
        let mut seen_blobs = std::collections::HashSet::new();

        for (idx, &(work_key, title, path, role, attr, has_family, text, date)) in
            docs.iter().enumerate()
        {
            let wid = WorkId::from_work_key(work_key).unwrap();
            if !seen_works.contains_key(work_key) {
                conn.execute(
                    "INSERT INTO works VALUES(?,?,?)",
                    params![wid.as_str(), work_key, title],
                )
                .unwrap();
                seen_works.insert(work_key, wid.clone());
                counts.works += 1;
                if has_family {
                    let wf = WorkFamily {
                        key: "test:family".to_owned(),
                        provenance: "test fixture".to_owned(),
                    };
                    conn.execute(
                        "INSERT INTO metadata VALUES(?,?)",
                        params![
                            format!("work_family:{}", wid.as_str()),
                            serde_json::to_string(&wf).unwrap()
                        ],
                    )
                    .unwrap();
                }
            }
            let raw = text.as_bytes();
            let chash = sha256_hex(raw);
            if seen_blobs.insert(chash.clone()) {
                conn.execute(
                    "INSERT INTO blobs VALUES(?,?,?)",
                    params![chash, raw, raw.len() as i64],
                )
                .unwrap();
                counts.blobs += 1;
            }
            let date_ymd = date.map(|d| DateYmd::parse(d).unwrap());
            let date_basis = date.map(|_| "fixture");
            let sid = SourceId::derive(
                &wid,
                path,
                role,
                attr,
                &chash,
                date_ymd.as_ref(),
                date_basis,
            );
            conn.execute(
                "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    sid.as_str(),
                    wid.as_str(),
                    path,
                    title,
                    role.as_str(),
                    attr.as_str(),
                    "fixture",
                    date,
                    date_basis,
                    Option::<String>::None,
                    chash
                ],
            )
            .unwrap();
            counts.sources += 1;
            counts.canonical_sources += 1;
            let eq_hash = sha256_hex(format!("equiv-v1:{text}").as_bytes());
            conn.execute(
                "INSERT INTO source_canonical_map VALUES(?,?,?,?,?)",
                params![
                    sid.as_str(),
                    sid.as_str(),
                    eq_hash,
                    "plain_text",
                    "unique_in_work_role"
                ],
            )
            .unwrap();

            let span = ByteSpan::new(0, raw.len(), None).unwrap();
            let pid = PassageId::derive(&sid, 0, std::slice::from_ref(&span));
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
            counts.passages += 1;
            conn.execute(
                "INSERT INTO inventory VALUES(?,?, 'indexed', 'ok', ?)",
                params![format!("{idx}_{path}"), work_key, chash],
            )
            .unwrap();
            counts.inventory += 1;
        }
        drop(conn);

        let release = ReleaseHash::parse(&"c".repeat(64)).unwrap();
        CorpusStore::validate_staging_db(&db_path, release.clone(), &counts).unwrap();
        let store = CorpusStore::open_readonly(&db_path, release).unwrap();
        (dir, store)
    }

    #[test]
    fn search_preserves_0050_qqq_4pct_and_work_diversity() {
        let (_dir, store) = build_test_store(&[
            (
                "w1",
                "ETF 0050",
                "w1_a.txt",
                "台灣0050指數投資長期持有",
                Some("2025-01-01"),
            ),
            (
                "w1",
                "ETF 0050",
                "w1_b.txt",
                "0050第二個事實：搭配現金部位",
                Some("2025-01-02"),
            ),
            (
                "w1",
                "ETF 0050",
                "w1_c.txt",
                "0050第三個事實：再平衡紀律",
                Some("2025-01-03"),
            ),
            (
                "w1",
                "ETF 0050",
                "w1_d.txt",
                "0050第四個事實：手續費考量",
                Some("2025-01-04"),
            ),
            (
                "w2",
                "美股 QQQ",
                "w2_a.txt",
                "美股QQQ與0050都是常見標的，每年提領4%法則",
                Some("2025-02-01"),
            ),
            (
                "w2",
                "美股 QQQ",
                "w2_b.txt",
                "0050與QQQ的稅務差異說明",
                Some("2025-02-02"),
            ),
            (
                "w3",
                "數字測試",
                "w3_a.txt",
                "存了50萬現金以及4個月生活費，不含百分比",
                Some("2025-03-01"),
            ),
            (
                "w4",
                "資產配置",
                "w4_a.txt",
                "0050作為台灣核心配置",
                Some("2025-04-01"),
            ),
        ]);

        let res_0050 = execute_search(
            &store,
            &PreparedSearch::prepare(SearchRequest {
                queries: vec!["0050".to_owned()],
                match_mode: MatchMode::Any,
                limit: 5,
                offset: 0,
                per_work: 2,
                work_filter: None,
                source_filter: None,
                role_filter: None,
                date_from: None,
                date_to: None,
                release_pin: None,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res_0050.hits.len(), 5);
        assert!(res_0050.hits.iter().all(|h| h.work.work_key != "w3"));
        let w1_count = res_0050
            .hits
            .iter()
            .filter(|h| h.work.work_key == "w1")
            .count();
        let w2_count = res_0050
            .hits
            .iter()
            .filter(|h| h.work.work_key == "w2")
            .count();
        let w4_count = res_0050
            .hits
            .iter()
            .filter(|h| h.work.work_key == "w4")
            .count();
        assert_eq!(w1_count, 2);
        assert_eq!(w2_count, 2);
        assert_eq!(w4_count, 1);

        let res_w1 = execute_search(
            &store,
            &PreparedSearch::prepare(SearchRequest {
                queries: vec!["0050".to_owned()],
                match_mode: MatchMode::Any,
                limit: 5,
                offset: 0,
                per_work: 2,
                work_filter: Some(WorkId::from_work_key("w1").unwrap()),
                source_filter: None,
                role_filter: None,
                date_from: None,
                date_to: None,
                release_pin: None,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res_w1.hits.len(), 4);

        let res_4pct = execute_search(
            &store,
            &PreparedSearch::prepare(SearchRequest {
                queries: vec!["4%".to_owned(), "qqq".to_owned()],
                match_mode: MatchMode::Any,
                limit: 5,
                offset: 0,
                per_work: 2,
                work_filter: None,
                source_filter: None,
                role_filter: None,
                date_from: None,
                date_to: None,
                release_pin: None,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res_4pct.hits.len(), 2);
        assert_eq!(res_4pct.hits[0].work.work_key, "w2");
        assert!(res_4pct.hits[0].excerpt.contains("4%"));

        let req = PreparedSearch::prepare(SearchRequest {
            queries: vec!["0050".to_owned(), "4%".to_owned()],
            match_mode: MatchMode::Any,
            limit: 5,
            offset: 0,
            per_work: 2,
            work_filter: None,
            source_filter: None,
            role_filter: None,
            date_from: None,
            date_to: None,
            release_pin: None,
        })
        .unwrap();
        let full = execute_search(&store, &req).unwrap();
        let candidates = collect_rrf_candidates(&store, &req).unwrap();
        let indices =
            apply_work_diversity_indices(&candidates, req.limit, req.per_work, |c| &c.work_id);
        let materialized: Vec<SearchHit> = indices
            .into_iter()
            .map(|idx| {
                let c = &candidates[idx];
                materialize_passage_hit(
                    &store,
                    &c.passage_id,
                    c.rrf_score,
                    c.matched_queries.clone(),
                )
                .unwrap()
            })
            .collect();
        assert_eq!(full.total_candidates, candidates.len());
        for (lead, original) in full.hits.iter().zip(&materialized) {
            assert_eq!(lead.passage_id, original.passage_id);
            assert_eq!(lead.rrf_score, Some(original.rrf_score));
            assert!(original.text.contains(&lead.excerpt));
        }
        assert_eq!(full.hits.len(), materialized.len());
    }

    #[test]
    fn search_pagination_is_disjoint_stable_and_handles_out_of_range_offset() {
        let (_dir, store) = build_test_store(&[
            ("w1", "W1", "1.txt", "pagetest alpha one", None),
            ("w1", "W1", "2.txt", "pagetest beta two", None),
            ("w1", "W1", "3.txt", "pagetest gamma three", None),
            ("w2", "W2", "4.txt", "pagetest delta four", None),
            ("w3", "W3", "5.txt", "pagetest epsilon five", None),
            ("w4", "W4", "6.txt", "pagetest zeta six", None),
        ]);

        let run_page = |limit, offset| {
            execute_search(
                &store,
                &PreparedSearch::prepare(SearchRequest {
                    queries: vec!["pagetest".to_owned()],
                    match_mode: MatchMode::Any,
                    limit,
                    offset,
                    per_work: 2,
                    work_filter: None,
                    source_filter: None,
                    role_filter: None,
                    date_from: None,
                    date_to: None,
                    release_pin: None,
                })
                .unwrap(),
            )
            .unwrap()
        };

        let all = run_page(6, 0);
        assert_eq!(all.total_candidates, 6);
        assert_eq!(all.hits.len(), 6);
        assert!(!all.has_more);
        assert_eq!(all.next_offset, None);

        let p0 = run_page(2, 0);
        let p1 = run_page(2, 2);
        let p2 = run_page(2, 4);
        assert_eq!(p0.offset, 0);
        assert_eq!(p0.limit, 2);
        assert!(p0.has_more);
        assert_eq!(p0.next_offset, Some(2));
        assert!(p1.has_more);
        assert_eq!(p1.next_offset, Some(4));
        assert!(!p2.has_more);
        assert_eq!(p2.next_offset, None);

        let stitched: Vec<_> = p0
            .hits
            .iter()
            .chain(&p1.hits)
            .chain(&p2.hits)
            .map(|h| h.passage_id.clone())
            .collect();
        let expected: Vec<_> = all.hits.iter().map(|h| h.passage_id.clone()).collect();
        assert_eq!(stitched, expected);

        let oob = run_page(2, 100);
        assert_eq!(oob.total_candidates, 6);
        assert!(oob.hits.is_empty());
        assert!(!oob.has_more);
        assert_eq!(oob.next_offset, None);
    }

    #[test]
    fn near_duplicate_demotion_clusters_traditional_simplified_and_prefers_cleaner_witness() {
        let base_trad = "退休日如果一開始遇到大幅回檔，同時固定從本金賣股換生活費，剩餘資產就會在市場低谷永久縮水，無法充分參與後來反彈恢復，因此動態提領率與再平衡備用現金部位的設計非常重要。";
        let base_simp = "退休日如果一开始遇到大幅回档，同时固定从本金卖股换生活费，剩余资产就会在市场低谷永久缩水，无法充分参与后来反弹恢复，因此动态提领率与再平衡备用现金部位的设计非常重要，而且必须留意通膨与维持率变化。";
        let base_asr = "退休日如果一開始遇到大幅回檔 同時固定從本金賣股換生活費 剩餘資產就會在市場低谷永久縮水 無法充分參與後來反彈恢復 因此動態提領率與再平衡備用現金部位的設計非常重要";
        let distinct_doc = "臺灣投資人買進零零六六二這檔追蹤那斯達克一百指數的台股掛牌基金時，除了觀察表面台幣計價淨值漲幅，還應該換算成美元口徑並扣除管理與託管內扣費用，同時比較美國本土掛牌交易時段流動性與追蹤誤差。";

        let (_dir, store) = build_rich_test_store(&[
            // Unverified archive transcript appears multiple times / matches more query keywords -> higher raw BM25
            (
                "w_arch",
                "歸檔逐字稿 退休 提領 動態 再平衡 現金",
                "archive/001.txt",
                SourceRole::Transcript,
                Attribution::UnverifiedTranscript,
                false,
                base_asr,
                None,
            ),
            // Cleaner family document edition with same core passage
            (
                "w_doc",
                "寶典第十五章",
                "docs/ch15.txt",
                SourceRole::Document,
                Attribution::OriginalUnknown,
                true,
                base_simp,
                None,
            ),
            // Website Traditional transcript clone
            (
                "w_web_tr",
                "EP073",
                "web/ep073.txt",
                SourceRole::Transcript,
                Attribution::AutomaticUnverified,
                false,
                base_trad,
                None,
            ),
            // Distinct topic passage sharing anchor term "退休"
            (
                "w_distinct",
                "00662 比較",
                "web/00662.txt",
                SourceRole::Document,
                Attribution::PublisherVerified,
                false,
                &format!("退休配置比較：{distinct_doc}"),
                None,
            ),
        ]);

        let base_req = PreparedSearch::prepare(SearchRequest {
            queries: vec!["退休 提領 動態 再平衡 現金".to_owned()],
            match_mode: MatchMode::Any,
            limit: 2,
            offset: 0,
            per_work: 2,
            work_filter: None,
            source_filter: None,
            role_filter: None,
            date_from: None,
            date_to: None,
            release_pin: None,
        })
        .unwrap();

        let ranked_raw = collect_rrf_candidates(&store, &base_req).unwrap();
        let raw_order =
            diversify_ranked_candidates(&store, base_req.normalization, &ranked_raw, 2, false)
                .unwrap();
        assert_eq!(
            store
                .load_work(&ranked_raw[raw_order[0]].work_id)
                .unwrap()
                .work_key,
            "w_arch"
        );

        let page1 = execute_search(&store, &base_req).unwrap();

        assert_eq!(page1.total_candidates, 4);
        assert_eq!(page1.hits.len(), 2);
        // Cleaner family document (`w_doc`) takes the first cluster slot instead of `w_arch`,
        // and the genuinely distinct document (`w_distinct`) is promoted into #2 ahead of clones.
        assert_eq!(page1.hits[0].work.work_key, "w_doc");
        assert_eq!(page1.hits[1].work.work_key, "w_distinct");

        let page2 = execute_search(
            &store,
            &PreparedSearch::prepare(SearchRequest {
                queries: vec!["退休 提領 動態 再平衡 現金".to_owned()],
                match_mode: MatchMode::Any,
                limit: 2,
                offset: 2,
                per_work: 2,
                work_filter: None,
                source_filter: None,
                role_filter: None,
                date_from: None,
                date_to: None,
                release_pin: None,
            })
            .unwrap(),
        )
        .unwrap();
        let all_keys: Vec<_> = page1
            .hits
            .iter()
            .chain(&page2.hits)
            .map(|h| h.work.work_key.as_str())
            .collect();
        assert_eq!(all_keys.len(), 4);
        assert!(all_keys.contains(&"w_arch") && all_keys.contains(&"w_web_tr"));
    }

    #[test]
    fn low_entropy_short_passages_are_not_falsely_deduplicated() {
        let p_a = format!("超限批次001 {}。", "丙".repeat(500));
        let p_b = format!("超限批次002 {}。", "丙".repeat(500));
        assert!(passage_shingles(Normalization::Current, &p_a).len() < NEAR_DUP_MIN_SHINGLES);

        let (_dir, store) = build_test_store(&[
            ("w1", "W1", "1.txt", &p_a, None),
            ("w2", "W2", "2.txt", &p_b, None),
        ]);
        let res = execute_search(
            &store,
            &PreparedSearch::prepare(SearchRequest {
                queries: vec!["超限批次001 超限批次002".to_owned()],
                match_mode: MatchMode::Any,
                limit: 2,
                offset: 0,
                per_work: 2,
                work_filter: None,
                source_filter: None,
                role_filter: None,
                date_from: None,
                date_to: None,
                release_pin: None,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res.hits.len(), 2);
        assert!(!is_near_duplicate(
            &passage_shingles(Normalization::Current, &p_a),
            &passage_shingles(Normalization::Current, &p_b),
        ));
    }
}
