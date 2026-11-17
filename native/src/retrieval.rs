use std::collections::{BTreeMap, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::domain::ByteSpan;
use crate::domain::{
    ClecError, DateYmd, ErrorCode, PassageId, ReleaseHash, SourceId, SourceRole, WorkId,
};
use crate::ingest::SubtitleCue;
use crate::lexical::{encode_fts_token, query_terms};
use crate::store::{CandidateFilter, CorpusStore, SourceRecord, WorkRecord};

pub(crate) const MAX_QUERIES: usize = 4;
pub(crate) const TOP_PER_QUERY: usize = 100;
pub(crate) const DEFAULT_SEARCH_LIMIT: usize = 5;
pub(crate) const MAX_SEARCH_LIMIT: usize = 5;
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
pub(crate) struct SearchData {
    pub release: ReleaseHash,
    pub match_mode: MatchMode,
    pub queries: Vec<SearchQueryTerms>,
    pub total_candidates: usize,
    pub hits: Vec<SearchHit>,
    pub budget: BudgetReport,
}

pub(crate) struct RankedCandidate {
    pub passage_id: PassageId,
    pub work_id: WorkId,
    pub rrf_score: f64,
    pub best_rank: usize,
    pub matched_queries: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedSearch {
    pub queries: Vec<SearchQueryTerms>,
    pub match_mode: MatchMode,
    pub limit: usize,
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
        if req.per_work == 0 || req.per_work > MAX_SEARCH_LIMIT {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                format!("--per-work must be 1..={MAX_SEARCH_LIMIT}."),
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
            let terms = query_terms(&q)?;
            parsed_queries.push(SearchQueryTerms { query: q, terms });
        }

        Ok(Self {
            queries: parsed_queries,
            match_mode: req.match_mode,
            limit: req.limit,
            per_work: req.per_work,
            work_filter: req.work_filter,
            source_filter: req.source_filter,
            role_filter: req.role_filter,
            date_from: req.date_from,
            date_to: req.date_to,
            release_pin: req.release_pin,
        })
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
    let selected_indices =
        apply_work_diversity_indices(&ranked, req.limit, req.per_work, |c| &c.work_id);

    let mut hits = Vec::with_capacity(selected_indices.len());
    for idx in selected_indices {
        let candidate = &ranked[idx];
        hits.push(materialize_passage_hit(
            store,
            &candidate.passage_id,
            candidate.rrf_score,
            candidate.matched_queries.clone(),
        )?);
    }

    Ok(SearchData {
        release: store.release.clone(),
        match_mode: req.match_mode,
        queries: req.queries.clone(),
        total_candidates,
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

        for (idx, (work_key, title, path, text, date)) in docs.iter().enumerate() {
            let wid = WorkId::from_work_key(work_key).unwrap();
            if !seen_works.contains_key(*work_key) {
                conn.execute(
                    "INSERT INTO works VALUES(?,?,?)",
                    params![wid.as_str(), work_key, title],
                )
                .unwrap();
                seen_works.insert(*work_key, wid.clone());
                counts.works += 1;
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
                SourceRole::Document,
                Attribution::AuthoredFixture,
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
                    "document",
                    "authored_fixture",
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
        assert_eq!(res_4pct.hits[0].matched_queries, vec!["4%", "qqq"]);

        let req = PreparedSearch::prepare(SearchRequest {
            queries: vec!["0050".to_owned(), "4%".to_owned()],
            match_mode: MatchMode::Any,
            limit: 5,
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
        assert_eq!(full.hits, materialized);
    }
}
