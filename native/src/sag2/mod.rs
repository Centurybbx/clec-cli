pub(crate) mod jev;

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::Instant;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::domain::{
    ByteSpan, ClecError, ErrorCode, PassageId, ReleaseHash, Sag2ErrorContext, Sag2Stage, WorkId,
};
use crate::ingest::SubtitleCue;
use crate::lexical::{Normalization, encode_fts_token};
use crate::retrieval::{
    BudgetReport, MatchMode, PreparedSearch, RankedCandidate, SearchQueryTerms,
    apply_work_diversity_indices, collect_rrf_candidates, diversify_ranked_candidates,
    is_near_duplicate, materialize_passage_hit, passage_shingles,
};
use crate::store::{CandidateFilter, CorpusStore, SourceRecord, WorkRecord};

use self::jev::{
    CandidateRecord, JEV_CONNECT_TIMEOUT, JEV_REQUEST_TIMEOUT, JevAdmissionPolicy, JevClient,
    MAX_CONCURRENT_REQUESTS, MAX_QUESTIONS_PER_BATCH, MAX_REQUEST_BODY_BYTES,
    MAX_REQUEST_HEADER_BYTES, MAX_RESPONSE_BYTES, SAG2_RUN_DEADLINE, SeedEvidence, UsageStatus,
    ValidatedJevConfig,
};

pub(crate) const ALGORITHM_NAME: &str = "sag2_native_v1";
pub(crate) const ALGORITHM_REVISION: &str = "sag2-native-v1-batched-full-context";
pub(crate) const MAX_INITIAL_POOL: usize = 100;
pub(crate) const MAX_EXPANSION_ROUNDS: usize = 1;
pub(crate) const SEED_K: usize = 10;
pub(crate) const MIN_SEED_SCORE: f64 = 0.25;
pub(crate) const SEED_CONTEXT_MAX_BYTES: usize = 40_960;
pub(crate) const EXPANSION_TERM_LIMIT: usize = 20;
pub(crate) const MAX_EXPANSION_NEW: usize = 100;
pub(crate) const MAX_SECOND_POOL: usize = 115;
pub(crate) const MAX_SCORED_OCCURRENCES: usize = 215;
pub(crate) const MAX_SQL_CANDIDATE_QUERIES: usize = 24;
pub(crate) const MAX_DF_LOOKUPS: usize = 8192;
pub(crate) const DPP_MIN_K: usize = 10;

pub(crate) fn effective_dpp_top_k(limit: usize) -> usize {
    limit.max(DPP_MIN_K)
}

const STOPWORDS: &[&str] = &[
    "的",
    "了",
    "是",
    "在",
    "和",
    "与",
    "或",
    "哪",
    "什么",
    "哪个",
    "哪些",
    "如何",
    "怎么",
    "为什么",
    "是否",
    "这",
    "那",
    "一个",
    "一种",
    "请",
    "我",
    "你",
    "他",
    "它",
    "吗",
    "呢",
    "吧",
    "地",
    "得",
    "the",
    "a",
    "an",
    "of",
    "in",
    "on",
    "at",
    "to",
    "for",
    "and",
    "or",
    "is",
    "are",
    "was",
    "were",
    "be",
    "by",
    "with",
    "from",
    "which",
    "what",
    "who",
    "how",
    "when",
    "where",
    "does",
    "do",
    "did",
    "that",
    "this",
    "it",
    "as",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Sag2StopReason {
    NoCandidates,
    NoQualifiedSeeds,
    NoExpansionTerms,
    NoExpansionCandidates,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sag2CandidateCounts {
    pub initial_rrf_total: usize,
    pub initial_pool: usize,
    pub seeds_selected: usize,
    pub expansion_terms_selected: usize,
    pub expansion_new_candidates: usize,
    pub second_pool: usize,
    pub scored_occurrences: usize,
    pub final_pool: usize,
    pub context_omitted_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sag2CallStats {
    pub http_attempts: usize,
    pub successful_batches: usize,
    pub sql_candidate_queries: usize,
    pub df_lookups_distinct: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sag2Limits {
    pub max_initial_pool: usize,
    pub max_expansion_rounds: usize,
    pub max_seed_k: usize,
    pub min_seed_score: f64,
    pub seed_context_max_bytes: usize,
    pub max_expansion_terms: usize,
    pub max_expansion_new: usize,
    pub max_second_pool: usize,
    pub max_scored_occurrences: usize,
    pub max_sql_candidate_queries: usize,
    pub max_df_lookups: usize,
    pub dpp_top_k: usize,
    pub max_concurrent_requests: usize,
    pub max_questions_per_batch: usize,
    pub max_request_header_bytes: usize,
    pub max_request_body_bytes: usize,
    pub max_response_bytes: usize,
    pub admission_policy: JevAdmissionPolicy,
    pub max_question_estimated_tokens: Option<usize>,
    pub max_batch_estimated_tokens: Option<usize>,
    pub connect_timeout_secs: u64,
    pub request_timeout_secs: u64,
    pub run_deadline_secs: u64,
}

impl Sag2Limits {
    pub(crate) fn for_policy(admission_policy: JevAdmissionPolicy, dpp_top_k: usize) -> Self {
        let (max_question_estimated_tokens, max_batch_estimated_tokens) =
            admission_policy.estimated_token_caps();
        Self {
            max_initial_pool: MAX_INITIAL_POOL,
            max_expansion_rounds: MAX_EXPANSION_ROUNDS,
            max_seed_k: SEED_K,
            min_seed_score: MIN_SEED_SCORE,
            seed_context_max_bytes: SEED_CONTEXT_MAX_BYTES,
            max_expansion_terms: EXPANSION_TERM_LIMIT,
            max_expansion_new: MAX_EXPANSION_NEW,
            max_second_pool: MAX_SECOND_POOL,
            max_scored_occurrences: MAX_SCORED_OCCURRENCES,
            max_sql_candidate_queries: MAX_SQL_CANDIDATE_QUERIES,
            max_df_lookups: MAX_DF_LOOKUPS,
            dpp_top_k,
            max_concurrent_requests: MAX_CONCURRENT_REQUESTS,
            max_questions_per_batch: MAX_QUESTIONS_PER_BATCH,
            max_request_header_bytes: MAX_REQUEST_HEADER_BYTES,
            max_request_body_bytes: MAX_REQUEST_BODY_BYTES,
            max_response_bytes: MAX_RESPONSE_BYTES,
            admission_policy,
            max_question_estimated_tokens,
            max_batch_estimated_tokens,
            connect_timeout_secs: JEV_CONNECT_TIMEOUT.as_secs(),
            request_timeout_secs: JEV_REQUEST_TIMEOUT.as_secs(),
            run_deadline_secs: SAG2_RUN_DEADLINE.as_secs(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sag2Consumption {
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub estimated_token_units: usize,
    pub token_estimate_basis: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Sag2MetadataStatus {
    Unknown,
    Reported,
}

impl From<UsageStatus> for Sag2MetadataStatus {
    fn from(value: UsageStatus) -> Self {
        match value {
            UsageStatus::Unknown => Self::Unknown,
            UsageStatus::Reported => Self::Reported,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sag2UsageProvenance {
    pub status: Sag2MetadataStatus,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_status: Sag2MetadataStatus,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sag2SearchHit {
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
    pub rrf_score: Option<f64>,
    pub matched_queries: Vec<String>,
    pub jev_score: f64,
    pub dpp_order: Option<usize>,
    pub found_in_round: usize,
    pub expansion_terms: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sag2SearchData {
    pub release: ReleaseHash,
    pub match_mode: MatchMode,
    pub queries: Vec<SearchQueryTerms>,
    pub algorithm: String,
    pub algorithm_revision: String,
    pub provider_verified: bool,
    pub requested_model: String,
    pub actual_model: Option<String>,
    pub rounds_completed: usize,
    pub stop_reason: Sag2StopReason,
    pub candidate_counts: Sag2CandidateCounts,
    pub calls: Sag2CallStats,
    pub limits: Sag2Limits,
    pub consumption: Sag2Consumption,
    pub usage: Sag2UsageProvenance,
    pub total_candidates: usize,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
    pub hits: Vec<Sag2SearchHit>,
    pub budget: BudgetReport,
}

struct PoolCandidate {
    passage_id: PassageId,
    work_id: WorkId,
    title: String,
    text: String,
    genuine_rrf_score: Option<f64>,
    matched_queries: Vec<String>,
    found_in_round: usize,
    retrieval_rank: usize,
    jev_score: f64,
    expansion_terms: Vec<String>,
    dpp_order: Option<usize>,
}

struct TermDfCache {
    entries: BTreeMap<String, usize>,
}

impl TermDfCache {
    fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn get(&mut self, store: &CorpusStore, term: &str) -> Result<usize, ClecError> {
        if let Some(&df) = self.entries.get(term) {
            return Ok(df);
        }
        if self.entries.len() >= MAX_DF_LOOKUPS {
            return Err(ClecError::new(
                ErrorCode::Sag2BudgetExhausted,
                format!("SAG2 exceeded {MAX_DF_LOOKUPS} distinct term document-frequency lookups."),
            ));
        }
        let df = store.body_term_document_frequency(term)?;
        self.entries.insert(term.to_owned(), df);
        Ok(df)
    }
}

#[derive(Debug, Clone)]
struct DerivedTerm {
    term: String,
    score: f64,
}

struct Sag2Tracker<'a> {
    stage: Sag2Stage,
    rounds_completed: usize,
    sql_candidate_queries: usize,
    df_cache: &'a TermDfCache,
    jev: &'a JevClient,
}

impl Sag2Tracker<'_> {
    fn snapshot(&self) -> Sag2ErrorContext {
        let acct = self.jev.accounting();
        Sag2ErrorContext {
            completed_stage: self.stage,
            rounds_completed: self.rounds_completed,
            http_attempts: acct.http_attempts,
            successful_batches: acct.successful_batches,
            scored_occurrences: acct.scored_occurrences,
            sql_candidate_queries: self.sql_candidate_queries,
            df_lookups_distinct: self.df_cache.len(),
            request_bytes: acct.request_bytes,
            response_bytes: acct.response_bytes,
            estimated_token_units: acct.estimated_token_units,
        }
    }
}

#[cfg(any(test, not(feature = "test-hooks")))]
pub(crate) fn run_sag2(
    store: &mut CorpusStore,
    req: &PreparedSearch,
    config: ValidatedJevConfig,
) -> Result<Sag2SearchData, ClecError> {
    run_sag2_internal(
        store,
        req,
        config,
        #[cfg(feature = "test-hooks")]
        None,
        #[cfg(feature = "test-hooks")]
        None,
    )
}

#[cfg(feature = "test-hooks")]
pub(crate) fn run_sag2_with_test_overrides(
    store: &mut CorpusStore,
    req: &PreparedSearch,
    config: ValidatedJevConfig,
    extra_root_pem: Option<Vec<u8>>,
    request_timeout: Option<std::time::Duration>,
) -> Result<Sag2SearchData, ClecError> {
    run_sag2_internal(store, req, config, extra_root_pem, request_timeout)
}

fn run_sag2_internal(
    store: &mut CorpusStore,
    req: &PreparedSearch,
    config: ValidatedJevConfig,
    #[cfg(feature = "test-hooks")] extra_root_pem: Option<Vec<u8>>,
    #[cfg(feature = "test-hooks")] request_timeout: Option<std::time::Duration>,
) -> Result<Sag2SearchData, ClecError> {
    if let Some(pin) = &req.release_pin
        && pin != &store.release
    {
        return Err(ClecError::new(
            ErrorCode::VersionUnavailable,
            "Active release differs from requested --release.",
        ));
    }

    #[cfg(feature = "test-hooks")]
    let run_deadline =
        Instant::now() + request_timeout.map_or(SAG2_RUN_DEADLINE, |t| SAG2_RUN_DEADLINE.min(t));
    #[cfg(not(feature = "test-hooks"))]
    let run_deadline = Instant::now() + SAG2_RUN_DEADLINE;
    store.set_deadline_progress_handler(run_deadline);

    let res = (|| -> Result<Sag2SearchData, ClecError> {
        let _snapshot = store.begin_read_snapshot()?;
        #[cfg(feature = "test-hooks")]
        let jev = JevClient::new(config, run_deadline)
            .with_test_overrides(extra_root_pem, request_timeout);
        #[cfg(not(feature = "test-hooks"))]
        let jev = JevClient::new(config, run_deadline);

        run_sag2_pinned(store, req, jev, run_deadline)
    })();

    store.clear_deadline_progress_handler();
    res
}

fn check_deadline(deadline: Instant) -> Result<(), ClecError> {
    if Instant::now() >= deadline {
        Err(ClecError::new(
            ErrorCode::TransferTimeout,
            "SAG2 run deadline of 90 seconds exceeded.",
        ))
    } else {
        Ok(())
    }
}

fn attach_stage(
    err: ClecError,
    stage: Sag2Stage,
    rounds_completed: usize,
    sql_candidate_queries: usize,
    df_cache: &TermDfCache,
    jev: &JevClient,
) -> ClecError {
    if err.sag2_stage.is_some() {
        return err;
    }
    let tracker = Sag2Tracker {
        stage,
        rounds_completed,
        sql_candidate_queries,
        df_cache,
        jev,
    };
    err.with_sag2_stage(tracker.snapshot())
}

fn run_sag2_pinned(
    store: &CorpusStore,
    req: &PreparedSearch,
    mut jev: JevClient,
    run_deadline: Instant,
) -> Result<Sag2SearchData, ClecError> {
    let mut df_cache = TermDfCache::new();
    let mut stage = Sag2Stage::Init;
    let mut rounds_completed = 0usize;
    let mut sql_candidate_queries = 0usize;

    macro_rules! map_err_stage {
        ($expr:expr) => {
            $expr.map_err(|e| {
                attach_stage(
                    e,
                    stage,
                    rounds_completed,
                    sql_candidate_queries,
                    &df_cache,
                    &jev,
                )
            })?
        };
    }

    map_err_stage!(check_deadline(run_deadline));
    let total_passages = map_err_stage!(store.passage_count());
    let initial_ranked: Vec<RankedCandidate> = map_err_stage!(collect_rrf_candidates(store, req));
    sql_candidate_queries = req.queries.len();
    stage = Sag2Stage::InitialRetrieval;

    let initial_rrf_total = initial_ranked.len();
    if initial_ranked.is_empty() {
        return Ok(build_sag2_search_data(
            store,
            req,
            &jev,
            Sag2StopReason::NoCandidates,
            0,
            Sag2CandidateCounts {
                initial_rrf_total: 0,
                initial_pool: 0,
                seeds_selected: 0,
                expansion_terms_selected: 0,
                expansion_new_candidates: 0,
                second_pool: 0,
                scored_occurrences: 0,
                final_pool: 0,
                context_omitted_count: 0,
            },
            sql_candidate_queries,
            df_cache.len(),
            Vec::new(),
        ));
    }

    let enable_dedup = req.work_filter.is_none() && req.source_filter.is_none();
    let ordered_initial = map_err_stage!(diversify_ranked_candidates(
        store,
        req.normalization,
        &initial_ranked,
        usize::MAX,
        enable_dedup,
    ));
    let initial_candidates: Vec<RankedCandidate> = ordered_initial
        .into_iter()
        .take(MAX_INITIAL_POOL)
        .map(|idx| initial_ranked[idx].clone())
        .collect();
    let initial_pool_len = initial_candidates.len();

    let mut pool0 = Vec::with_capacity(initial_pool_len);
    for (rank, cand) in initial_candidates.into_iter().enumerate() {
        map_err_stage!(check_deadline(run_deadline));
        let hit = map_err_stage!(materialize_passage_hit(
            store,
            &cand.passage_id,
            cand.rrf_score,
            cand.matched_queries,
        ));
        pool0.push(PoolCandidate {
            passage_id: hit.passage_id,
            work_id: hit.work.work_id,
            title: hit.source.title,
            text: hit.text,
            genuine_rrf_score: Some(hit.rrf_score),
            matched_queries: hit.matched_queries,
            found_in_round: 0,
            retrieval_rank: rank,
            jev_score: 0.0,
            expansion_terms: Vec::new(),
            dpp_order: None,
        });
    }

    let r0_records: Vec<CandidateRecord> = pool0
        .iter()
        .map(|c| CandidateRecord {
            passage_id: c.passage_id.clone(),
            title: c.title.clone(),
            passage: c.text.clone(),
        })
        .collect();
    let original_question = req.queries[0].query.as_str();
    let r0_outcome = map_err_stage!(jev.score_round(original_question, &[], &r0_records));
    for cand in &mut pool0 {
        cand.jev_score = *r0_outcome.scores.get(&cand.passage_id).ok_or_else(|| {
            attach_stage(
                ClecError::new(
                    ErrorCode::JevInvalidResponse,
                    "Missing Jev score for Round 0 candidate.",
                ),
                stage,
                rounds_completed,
                sql_candidate_queries,
                &df_cache,
                &jev,
            )
        })?;
    }
    rounds_completed = 1;
    stage = Sag2Stage::InitialScoring;

    let mut r0_sorted_indices: Vec<usize> = (0..pool0.len()).collect();
    r0_sorted_indices.sort_by(|&ia, &ib| {
        let a = &pool0[ia];
        let b = &pool0[ib];
        b.jev_score
            .total_cmp(&a.jev_score)
            .then_with(|| a.retrieval_rank.cmp(&b.retrieval_rank))
            .then_with(|| a.passage_id.cmp(&b.passage_id))
    });

    let qualified_seed_indices: Vec<usize> = r0_sorted_indices
        .iter()
        .copied()
        .filter(|&i| pool0[i].jev_score >= MIN_SEED_SCORE)
        .take(SEED_K)
        .collect();

    let mut seeds_selected = 0usize;
    let mut expansion_terms_selected = 0usize;
    let mut expansion_new_candidates = 0usize;
    let mut second_pool_len = 0usize;
    let mut context_omitted_count = 0usize;

    let (mut active_pool, stop_reason) = if qualified_seed_indices.is_empty() {
        (pool0, Sag2StopReason::NoQualifiedSeeds)
    } else {
        let mut selected_seed_indices = Vec::with_capacity(qualified_seed_indices.len());
        let mut seed_context = Vec::with_capacity(qualified_seed_indices.len());
        for &idx in &qualified_seed_indices {
            let cand = &pool0[idx];
            let entry = SeedEvidence {
                title: cand.title.clone(),
                passage: cand.text.clone(),
                previous_jev_score: Some(cand.jev_score),
            };
            let mut trial_context = seed_context.clone();
            trial_context.push(entry.clone());
            let shared_bytes = map_err_stage!(jev::shared_state_json_bytes(
                jev.requested_model(),
                original_question,
                &trial_context,
            ));
            if shared_bytes <= SEED_CONTEXT_MAX_BYTES {
                selected_seed_indices.push(idx);
                seed_context.push(entry);
            } else if selected_seed_indices.is_empty() {
                selected_seed_indices.push(idx);
                seed_context.push(entry);
                break;
            } else {
                break;
            }
        }
        seeds_selected = selected_seed_indices.len();
        let seed_budget_omitted = qualified_seed_indices.len().saturating_sub(seeds_selected);
        let selected_seed_ids: Vec<PassageId> = selected_seed_indices
            .iter()
            .map(|&i| pool0[i].passage_id.clone())
            .collect();

        let mut original_terms: HashSet<String> = HashSet::new();
        for pq in &req.queries {
            for term in &pq.terms {
                original_terms.insert(term.clone());
            }
        }

        map_err_stage!(check_deadline(run_deadline));
        let seeds_for_terms: Vec<&PoolCandidate> =
            selected_seed_indices.iter().map(|&i| &pool0[i]).collect();
        let derived_terms = map_err_stage!(derive_expansion_terms(
            store,
            &mut df_cache,
            total_passages,
            &original_terms,
            &seeds_for_terms,
            run_deadline,
        ));
        stage = Sag2Stage::ExpansionTerms;
        expansion_terms_selected = derived_terms.len();

        if derived_terms.is_empty() {
            context_omitted_count = seed_budget_omitted;
            (pool0, Sag2StopReason::NoExpansionTerms)
        } else {
            let seen_ids: Vec<PassageId> = pool0.iter().map(|c| c.passage_id.clone()).collect();
            let filter = CandidateFilter {
                work_filter: req.work_filter.as_ref(),
                source_filter: req.source_filter.as_ref(),
                role_filter: req.role_filter,
                date_from: req.date_from.as_ref(),
                date_to: req.date_to.as_ref(),
            };

            let mut term_lists = Vec::with_capacity(derived_terms.len());
            for dterm in &derived_terms {
                map_err_stage!(check_deadline(run_deadline));
                let fts_query = format!("\"{}\"", encode_fts_token(&dterm.term));
                sql_candidate_queries += 1;
                let list = map_err_stage!(store.query_bm25_candidates_excluding(
                    &fts_query,
                    &filter,
                    &seen_ids,
                    MAX_INITIAL_POOL,
                ));
                term_lists.push(list);
            }
            stage = Sag2Stage::ExpansionRetrieval;

            let mut seen_exp: HashSet<PassageId> = seen_ids.iter().cloned().collect();
            let mut seen_shingles: Vec<Vec<u64>> = if enable_dedup {
                pool0
                    .iter()
                    .map(|c| passage_shingles(req.normalization, &c.text))
                    .collect()
            } else {
                Vec::new()
            };
            let mut merged_new: Vec<(PassageId, Vec<String>)> = Vec::new();
            'outer: for rank in 0..MAX_INITIAL_POOL {
                for (t_idx, list) in term_lists.iter().enumerate() {
                    let Some(cand) = list.get(rank) else {
                        continue;
                    };
                    if seen_exp.insert(cand.passage_id.clone()) {
                        if enable_dedup {
                            let info =
                                map_err_stage!(store.load_passage_dedup_info(&cand.passage_id));
                            let shingles = passage_shingles(req.normalization, &info.text);
                            if seen_shingles
                                .iter()
                                .any(|prev| is_near_duplicate(&shingles, prev))
                            {
                                continue;
                            }
                            seen_shingles.push(shingles);
                        }
                        merged_new.push((
                            cand.passage_id.clone(),
                            vec![derived_terms[t_idx].term.clone()],
                        ));
                        if merged_new.len() == MAX_EXPANSION_NEW {
                            break 'outer;
                        }
                    }
                }
            }
            expansion_new_candidates = merged_new.len();

            if merged_new.is_empty() {
                context_omitted_count = seed_budget_omitted;
                (pool0, Sag2StopReason::NoExpansionCandidates)
            } else {
                let mut pool0_by_id: BTreeMap<PassageId, PoolCandidate> = pool0
                    .into_iter()
                    .map(|c| (c.passage_id.clone(), c))
                    .collect();

                let mut ordered_carry_ids = Vec::new();
                let mut carried_set = BTreeSet::new();

                let mut r0_by_rank: Vec<PassageId> = pool0_by_id.keys().cloned().collect();
                r0_by_rank.sort_by_key(|pid| pool0_by_id[pid].retrieval_rank);
                for pid in r0_by_rank.iter().take(5) {
                    if carried_set.insert(pid.clone()) {
                        ordered_carry_ids.push(pid.clone());
                    }
                }
                for pid in &selected_seed_ids {
                    if carried_set.insert(pid.clone()) {
                        ordered_carry_ids.push(pid.clone());
                    }
                }

                let mut pool1 = Vec::with_capacity(ordered_carry_ids.len() + merged_new.len());
                for pid in ordered_carry_ids {
                    if let Some(existing) = pool0_by_id.remove(&pid) {
                        pool1.push(existing);
                    }
                }
                for (exp_rank, (pid, exp_terms)) in merged_new.into_iter().enumerate() {
                    map_err_stage!(check_deadline(run_deadline));
                    let hit = map_err_stage!(materialize_passage_hit(store, &pid, 0.0, Vec::new()));
                    pool1.push(PoolCandidate {
                        passage_id: hit.passage_id,
                        work_id: hit.work.work_id,
                        title: hit.source.title,
                        text: hit.text,
                        genuine_rrf_score: None,
                        matched_queries: Vec::new(),
                        found_in_round: 1,
                        retrieval_rank: exp_rank,
                        jev_score: 0.0,
                        expansion_terms: exp_terms,
                        dpp_order: None,
                    });
                }

                second_pool_len = pool1.len();
                let r1_records: Vec<CandidateRecord> = pool1
                    .iter()
                    .map(|c| CandidateRecord {
                        passage_id: c.passage_id.clone(),
                        title: c.title.clone(),
                        passage: c.text.clone(),
                    })
                    .collect();

                let r1_outcome =
                    map_err_stage!(jev.score_round(original_question, &seed_context, &r1_records));
                context_omitted_count = seed_budget_omitted + r1_outcome.context_omitted_count;

                for cand in &mut pool1 {
                    cand.jev_score = *r1_outcome.scores.get(&cand.passage_id).ok_or_else(|| {
                        attach_stage(
                            ClecError::new(
                                ErrorCode::JevInvalidResponse,
                                "Missing Jev score for Round 1 candidate.",
                            ),
                            stage,
                            rounds_completed,
                            sql_candidate_queries,
                            &df_cache,
                            &jev,
                        )
                    })?;
                }
                rounds_completed = 2;
                stage = Sag2Stage::ExpansionScoring;
                (pool1, Sag2StopReason::Completed)
            }
        }
    };

    map_err_stage!(check_deadline(run_deadline));
    active_pool.sort_by(|a, b| {
        b.jev_score
            .total_cmp(&a.jev_score)
            .then_with(|| a.found_in_round.cmp(&b.found_in_round))
            .then_with(|| {
                b.genuine_rrf_score
                    .unwrap_or(0.0)
                    .total_cmp(&a.genuine_rrf_score.unwrap_or(0.0))
            })
            .then_with(|| a.retrieval_rank.cmp(&b.retrieval_rank))
            .then_with(|| a.passage_id.cmp(&b.passage_id))
    });

    let dpp_top_k = effective_dpp_top_k(req.limit);
    let dpp_len = active_pool.len().min(dpp_top_k);
    let dpp_order = map_err_stage!(rank_dpp_indices(
        store,
        &mut df_cache,
        total_passages,
        &active_pool[..dpp_len],
        run_deadline,
    ));

    let mut reordered_pool = Vec::with_capacity(active_pool.len());
    let mut slots: Vec<Option<PoolCandidate>> = active_pool.into_iter().map(Some).collect();
    for (pos, idx) in dpp_order.into_iter().enumerate() {
        let mut item = slots[idx].take().expect("dpp index unique");
        item.dpp_order = Some(pos + 1);
        reordered_pool.push(item);
    }
    for slot in slots.into_iter().skip(dpp_len).flatten() {
        reordered_pool.push(slot);
    }
    stage = Sag2Stage::DppRanking;

    let final_pool_len = reordered_pool.len();
    let selected_indices =
        apply_work_diversity_indices(&reordered_pool, req.limit, req.per_work, |c| &c.work_id);

    let mut final_hits = Vec::with_capacity(selected_indices.len());
    for idx in selected_indices {
        map_err_stage!(check_deadline(run_deadline));
        let cand = &reordered_pool[idx];
        let item = map_err_stage!(store.read_passage(&cand.passage_id, 0, None));
        final_hits.push(Sag2SearchHit {
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
            rrf_score: cand.genuine_rrf_score,
            matched_queries: cand.matched_queries.clone(),
            jev_score: cand.jev_score,
            dpp_order: cand.dpp_order,
            found_in_round: cand.found_in_round,
            expansion_terms: cand.expansion_terms.clone(),
        });
    }
    stage = Sag2Stage::Materialization;
    let _ = stage;

    if expansion_terms_selected > EXPANSION_TERM_LIMIT {
        expansion_terms_selected = EXPANSION_TERM_LIMIT;
    }

    let acct = jev.accounting();
    Ok(build_sag2_search_data(
        store,
        req,
        &jev,
        stop_reason,
        rounds_completed,
        Sag2CandidateCounts {
            initial_rrf_total,
            initial_pool: initial_pool_len,
            seeds_selected,
            expansion_terms_selected,
            expansion_new_candidates,
            second_pool: second_pool_len,
            scored_occurrences: acct.scored_occurrences,
            final_pool: final_pool_len,
            context_omitted_count,
        },
        sql_candidate_queries,
        df_cache.len(),
        final_hits,
    ))
}

pub(crate) fn minimum_sag2_search_data(
    prepared: &PreparedSearch,
    max_bytes: usize,
) -> Sag2SearchData {
    let policy = JevAdmissionPolicy::CalibratedJev114BodyBounded;
    let min_release = ReleaseHash::parse(&"0".repeat(64)).expect("64 zero hex digits valid");
    Sag2SearchData {
        release: min_release,
        match_mode: prepared.match_mode,
        queries: prepared.queries.clone(),
        algorithm: ALGORITHM_NAME.to_owned(),
        algorithm_revision: ALGORITHM_REVISION.to_owned(),
        provider_verified: false,
        requested_model: "a".to_owned(),
        actual_model: Some("a".to_owned()),
        rounds_completed: 0,
        stop_reason: Sag2StopReason::Completed,
        candidate_counts: Sag2CandidateCounts {
            initial_rrf_total: 0,
            initial_pool: 0,
            seeds_selected: 0,
            expansion_terms_selected: 0,
            expansion_new_candidates: 0,
            second_pool: 0,
            scored_occurrences: 0,
            final_pool: 0,
            context_omitted_count: 0,
        },
        calls: Sag2CallStats {
            http_attempts: 0,
            successful_batches: 0,
            sql_candidate_queries: 0,
            df_lookups_distinct: 0,
        },
        limits: Sag2Limits::for_policy(policy, effective_dpp_top_k(prepared.limit)),
        consumption: Sag2Consumption {
            request_bytes: 0,
            response_bytes: 0,
            estimated_token_units: 0,
            token_estimate_basis: policy.token_estimate_basis().to_owned(),
        },
        usage: Sag2UsageProvenance {
            status: Sag2MetadataStatus::Unknown,
            input_tokens: Some(0),
            output_tokens: Some(0),
            cost_status: Sag2MetadataStatus::Unknown,
            cost_usd: Some(0.0),
        },
        total_candidates: 0,
        offset: 0,
        limit: prepared.limit,
        has_more: true,
        hits: Vec::new(),
        budget: BudgetReport {
            max_bytes,
            used_bytes: 0,
            omitted_count: 0,
            omitted_ids: Vec::new(),
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn build_sag2_search_data(
    store: &CorpusStore,
    req: &PreparedSearch,
    jev: &JevClient,
    stop_reason: Sag2StopReason,
    rounds_completed: usize,
    candidate_counts: Sag2CandidateCounts,
    sql_candidate_queries: usize,
    df_lookups_distinct: usize,
    hits: Vec<Sag2SearchHit>,
) -> Sag2SearchData {
    let policy = jev.admission_policy();
    let acct = jev.accounting();
    let total_candidates = candidate_counts.final_pool;
    let has_more = hits.len() < total_candidates;
    Sag2SearchData {
        release: store.release.clone(),
        match_mode: req.match_mode,
        queries: req.queries.clone(),
        algorithm: ALGORITHM_NAME.to_owned(),
        algorithm_revision: ALGORITHM_REVISION.to_owned(),
        provider_verified: false,
        requested_model: jev.requested_model().to_owned(),
        actual_model: acct.actual_model,
        rounds_completed,
        stop_reason,
        candidate_counts,
        calls: Sag2CallStats {
            http_attempts: acct.http_attempts,
            successful_batches: acct.successful_batches,
            sql_candidate_queries,
            df_lookups_distinct,
        },
        limits: Sag2Limits::for_policy(policy, effective_dpp_top_k(req.limit)),
        consumption: Sag2Consumption {
            request_bytes: acct.request_bytes,
            response_bytes: acct.response_bytes,
            estimated_token_units: acct.estimated_token_units,
            token_estimate_basis: policy.token_estimate_basis().to_owned(),
        },
        usage: Sag2UsageProvenance {
            status: acct.usage_status.into(),
            input_tokens: acct.input_tokens,
            output_tokens: acct.output_tokens,
            cost_status: acct.cost_status.into(),
            cost_usd: acct.cost_usd,
        },
        total_candidates,
        offset: req.offset,
        limit: req.limit,
        has_more,
        hits,
        budget: BudgetReport {
            max_bytes: 0,
            used_bytes: 0,
            omitted_count: 0,
            omitted_ids: Vec::new(),
        },
    }
}

fn is_stopword(term: &str) -> bool {
    STOPWORDS.contains(&term)
}

fn tokenize_non_stop(normalization: Normalization, text: &str) -> Vec<String> {
    normalization
        .tokenize_normalized(text)
        .into_iter()
        .filter(|t| !is_stopword(t))
        .collect()
}

fn split_sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        let ch = text[i..].chars().next().unwrap();
        let next_i = i + ch.len_utf8();

        if ch == '\n' {
            let seg = &text[start..i];
            if !seg.trim().is_empty() {
                out.push(seg);
            }
            let mut k = next_i;
            while k < bytes.len() && bytes[k] == b'\n' {
                k += 1;
            }
            start = k;
            i = k;
            continue;
        }

        if matches!(ch, '。' | '！' | '？') {
            let mut k = next_i;
            while k < bytes.len() {
                let c2 = text[k..].chars().next().unwrap();
                if matches!(c2, '。' | '！' | '？') {
                    k += c2.len_utf8();
                } else {
                    break;
                }
            }
            while k < bytes.len() {
                let c2 = text[k..].chars().next().unwrap();
                if c2.is_whitespace() && c2 != '\n' {
                    k += c2.len_utf8();
                } else {
                    break;
                }
            }
            let seg = &text[start..k];
            if !seg.trim().is_empty() {
                out.push(seg);
            }
            start = k;
            i = k;
            continue;
        }

        if matches!(ch, '.' | '!' | '?') && next_i < bytes.len() {
            let next_ch = text[next_i..].chars().next().unwrap();
            if next_ch.is_whitespace() {
                let single_upper_initial = if ch == '.' && i > start {
                    let prev_char = text[start..i].chars().next_back();
                    let before_prev = prev_char.and_then(|pc| {
                        let p_idx = i - pc.len_utf8();
                        if p_idx == start {
                            None
                        } else {
                            text[start..p_idx].chars().next_back()
                        }
                    });
                    prev_char.is_some_and(|c| c.is_ascii_uppercase())
                        && before_prev.is_none_or(|c| !c.is_alphanumeric())
                } else {
                    false
                };
                if !single_upper_initial {
                    let mut k = next_i;
                    while k < bytes.len() {
                        let c2 = text[k..].chars().next().unwrap();
                        if c2.is_whitespace() {
                            k += c2.len_utf8();
                        } else {
                            break;
                        }
                    }
                    let seg = &text[start..k];
                    if !seg.trim().is_empty() {
                        out.push(seg);
                    }
                    start = k;
                    i = k;
                    continue;
                }
            }
        }

        i = next_i;
    }

    if start < text.len() {
        let seg = &text[start..];
        if !seg.trim().is_empty() {
            out.push(seg);
        }
    }
    out
}

fn bm25_idf(total_passages: usize, df: usize) -> f64 {
    let n = total_passages as f64;
    let f = (df as f64).min(n);
    (1.0 + (n - f + 0.5) / (f + 0.5)).ln()
}

fn derive_expansion_terms(
    store: &CorpusStore,
    df_cache: &mut TermDfCache,
    total_passages: usize,
    original_terms: &HashSet<String>,
    seeds: &[&PoolCandidate],
    run_deadline: Instant,
) -> Result<Vec<DerivedTerm>, ClecError> {
    if total_passages == 0 || seeds.is_empty() {
        return Ok(Vec::new());
    }

    let max_score = seeds.iter().map(|s| s.jev_score).fold(0.0_f64, f64::max);

    let mut ranked: BTreeMap<String, DerivedTerm> = BTreeMap::new();

    for seed in seeds {
        check_deadline(run_deadline)?;
        let sentences = split_sentences(&seed.text);
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut context_scores: BTreeMap<String, f64> = BTreeMap::new();

        for sentence in sentences {
            let tokens = tokenize_non_stop(store.normalization, sentence);
            if tokens.is_empty() {
                continue;
            }
            let mut unique_sent: Vec<String> = Vec::new();
            let mut seen_sent = HashSet::new();
            for tok in tokens {
                *counts.entry(tok.clone()).or_insert(0) += 1;
                if seen_sent.insert(tok.clone()) {
                    unique_sent.push(tok);
                }
            }

            let mut context = 0.0_f64;
            for tok in &unique_sent {
                if original_terms.contains(tok) {
                    let df = df_cache.get(store, tok)?;
                    context += bm25_idf(total_passages, df);
                }
            }
            for tok in unique_sent {
                let entry = context_scores.entry(tok).or_insert(0.0);
                if context > *entry {
                    *entry = context;
                }
            }
        }

        let weight = 0.5
            + 0.5
                * if max_score > 0.0 {
                    seed.jev_score / max_score
                } else {
                    0.0
                };

        for (term, tf) in counts {
            if original_terms.contains(&term) {
                continue;
            }
            let df = df_cache.get(store, &term)?;
            if df == 0 {
                continue;
            }
            let context = context_scores.get(&term).copied().unwrap_or(0.0);
            let idf = bm25_idf(total_passages, df);
            let unweighted = (1.0 + (tf as f64).ln()) * idf * (1.0 + context);
            let score = unweighted * weight;
            let update = ranked.get(&term).is_none_or(|prev| score > prev.score);
            if update {
                ranked.insert(term.clone(), DerivedTerm { term, score });
            }
        }
    }

    let mut list: Vec<DerivedTerm> = ranked.into_values().collect();
    list.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.term.cmp(&b.term))
    });
    list.truncate(EXPANSION_TERM_LIMIT);
    Ok(list)
}

fn dpp_idf(total_passages: usize, df: usize) -> f64 {
    let n = total_passages as f64;
    let f = df as f64;
    ((1.0 + n) / (1.0 + f)).ln() + 1.0
}

fn float_ulp(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        0.0
    } else {
        let abs = x.abs();
        let next = f64::from_bits(abs.to_bits() + 1);
        next - abs
    }
}

fn sorted_sparse_dot(a: &[(String, f64)], b: &[(String, f64)]) -> f64 {
    let mut ia = 0usize;
    let mut ib = 0usize;
    let mut sum = 0.0_f64;
    while ia < a.len() && ib < b.len() {
        match a[ia].0.cmp(&b[ib].0) {
            std::cmp::Ordering::Less => ia += 1,
            std::cmp::Ordering::Greater => ib += 1,
            std::cmp::Ordering::Equal => {
                sum += a[ia].1 * b[ib].1;
                ia += 1;
                ib += 1;
            }
        }
    }
    sum
}

fn rank_dpp_indices(
    store: &CorpusStore,
    df_cache: &mut TermDfCache,
    total_passages: usize,
    candidates: &[PoolCandidate],
    run_deadline: Instant,
) -> Result<Vec<usize>, ClecError> {
    let k = candidates.len();
    if k <= 1 {
        return Ok((0..k).collect());
    }

    let mut vectors: Vec<Vec<(String, f64)>> = Vec::with_capacity(k);
    for cand in candidates {
        check_deadline(run_deadline)?;
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for tok in tokenize_non_stop(store.normalization, &cand.text) {
            *counts.entry(tok).or_insert(0) += 1;
        }
        let mut sparse = Vec::with_capacity(counts.len());
        let mut norm_sq = 0.0_f64;
        for (term, tf) in counts {
            let df = df_cache.get(store, &term)?;
            let w = (1.0 + (tf as f64).ln()) * dpp_idf(total_passages, df);
            norm_sq += w * w;
            sparse.push((term, w));
        }
        let norm = norm_sq.sqrt();
        if norm > 0.0 {
            for (_, val) in &mut sparse {
                *val /= norm;
            }
        } else {
            sparse.clear();
        }
        vectors.push(sparse);
    }

    let scores: Vec<f64> = candidates.iter().map(|c| c.jev_score).collect();
    let mut kernel = vec![vec![0.0_f64; k]; k];
    for i in 0..k {
        kernel[i][i] = scores[i] * scores[i];
        for j in (i + 1)..k {
            let dot = sorted_sparse_dot(&vectors[i], &vectors[j]);
            let entry = scores[i] * scores[j] * dot;
            kernel[i][j] = entry;
            kernel[j][i] = entry;
        }
    }

    let mut residuals: Vec<f64> = scores.iter().map(|&s| s * s).collect();
    let max_res = residuals.iter().copied().fold(0.0_f64, f64::max);
    let tolerance = (k as f64) * float_ulp(max_res);

    let mut coefficients: Vec<Vec<f64>> = vec![Vec::new(); k];
    let mut remaining: Vec<usize> = (0..k).collect();
    let mut order = Vec::with_capacity(k);

    while !remaining.is_empty() {
        let mut best_pos = 0usize;
        let mut best_val = residuals[remaining[0]];
        for (pos, &idx) in remaining.iter().enumerate().skip(1) {
            if residuals[idx] > best_val {
                best_val = residuals[idx];
                best_pos = pos;
            }
        }
        let winner = remaining[best_pos];
        if residuals[winner] <= tolerance {
            order.extend(remaining);
            break;
        }
        order.push(winner);
        remaining.remove(best_pos);
        let denom = residuals[winner].sqrt();
        for &i in &remaining {
            let dot_coeff: f64 = coefficients[winner]
                .iter()
                .zip(coefficients[i].iter())
                .map(|(&a, &b)| a * b)
                .sum();
            let projection = (kernel[winner][i] - dot_coeff) / denom;
            coefficients[i].push(projection);
            residuals[i] = (residuals[i] - projection * projection).max(0.0);
        }
    }

    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        Attribution, ByteSpan, CORPUS_FORMAT, DICTIONARY_REVISION, EQUIVALENCE_REVISION,
        NORMALIZATION_REVISION, SEGMENTATION_REVISION, SourceId, TOKENIZATION_REVISION, sha256_hex,
    };
    use crate::lexical::index_tokens_string;
    use crate::retrieval::{SearchRequest, execute_search};
    use crate::store::{CorpusCounts, SCHEMA_SQL};
    use rusqlite::{Connection, params};
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn build_sag2_test_store(
        docs: &[(&str, &str, &str, &str)],
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
        let mut seen_works = HashSet::new();
        let mut seen_blobs = HashSet::new();

        for (idx, (work_key, title, path, text)) in docs.iter().enumerate() {
            let wid = WorkId::from_work_key(work_key).unwrap();
            if seen_works.insert(*work_key) {
                conn.execute(
                    "INSERT INTO works VALUES(?,?,?)",
                    params![wid.as_str(), work_key, title],
                )
                .unwrap();
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
            let sid = SourceId::derive(
                &wid,
                path,
                crate::domain::SourceRole::Document,
                Attribution::AuthoredFixture,
                &chash,
                None,
                None,
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
                    Option::<String>::None,
                    Option::<String>::None,
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

        let release = ReleaseHash::parse(&"b".repeat(64)).unwrap();
        CorpusStore::validate_staging_db(&db_path, release.clone(), &counts).unwrap();
        let store = CorpusStore::open_readonly(&db_path, release).unwrap();
        (dir, store)
    }

    #[test]
    fn one_hop_bridge_discovery_and_zero_candidate_termination() {
        let (_dir, mut store) = build_sag2_test_store(&[
            (
                "w_alpha",
                "Alpha Bridge",
                "a.txt",
                "星辰協議採用赤道轉發器「霓虹鯨」作為中繼。",
            ),
            (
                "w_beta",
                "Beta Target",
                "b.txt",
                "「霓虹鯨」的最終認證密鑰存放於南極觀測塔。",
            ),
            ("w_noise", "Noise", "n.txt", "星辰協議是一份普通說明文件。"),
        ]);

        let local_req = PreparedSearch::prepare(SearchRequest {
            queries: vec!["星辰協議".to_owned()],
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
        let local_res = execute_search(&store, &local_req).unwrap();
        assert!(local_res.hits.iter().all(|h| h.work.work_key != "w_beta"));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut content_len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_len];
                reader.read_exact(&mut body).unwrap();
                let req_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let questions = req_json["questions"].as_object().unwrap();
                let mut answers = serde_json::Map::new();
                for (k, q) in questions {
                    let passage = q["instructions"]["candidate_passage"].as_str().unwrap();
                    let score = if passage.contains("南極觀測塔") {
                        0.98
                    } else if passage.contains("霓虹鯨") {
                        0.85
                    } else {
                        0.10
                    };
                    answers.insert(
                        k.clone(),
                        serde_json::json!({"type": "noul", "noul": score}),
                    );
                }
                let resp_body = serde_json::to_vec(&serde_json::json!({
                    "model": "typesafe/jev-1.14",
                    "answers": answers,
                    "usage": {"input_tokens": 100, "output_tokens": 10, "cost": 0.0001},
                }))
                .unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    resp_body.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&resp_body).unwrap();
                stream.flush().unwrap();
            }
        });

        let mut env_map = HashMap::new();
        env_map.insert(
            "JEV_BASE_URL",
            format!("http://127.0.0.1:{}/decisions", addr.port()),
        );
        env_map.insert("JEV_API_KEY", "dummy-sentinel".to_owned());
        let cfg = ValidatedJevConfig::from_lookup(None, |k| env_map.get(k).cloned()).unwrap();

        let sag2_res = run_sag2(&mut store, &local_req, cfg.clone()).unwrap();
        assert_eq!(sag2_res.stop_reason, Sag2StopReason::Completed);
        assert_eq!(sag2_res.rounds_completed, 2);
        assert_eq!(sag2_res.calls.http_attempts, 2);
        assert_eq!(sag2_res.hits[0].work.work_key, "w_beta");
        assert_eq!(sag2_res.hits[0].rrf_score, None);
        assert_eq!(sag2_res.hits[0].found_in_round, 1);
        assert!(sag2_res.hits[1].rrf_score.is_some());
        srv.join().unwrap();

        let empty_req = PreparedSearch::prepare(SearchRequest {
            queries: vec!["zzqyxwvutnonexistent".to_owned()],
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
        let zero_res = run_sag2(&mut store, &empty_req, cfg).unwrap();
        assert_eq!(zero_res.stop_reason, Sag2StopReason::NoCandidates);
        assert_eq!(zero_res.calls.http_attempts, 0);
        assert_eq!(zero_res.calls.df_lookups_distinct, 0);
        assert!(zero_res.hits.is_empty());
    }

    #[test]
    fn dpp_handles_zero_scores_empty_vectors_and_duplicate_vectors_deterministically() {
        let (_dir, store) = build_sag2_test_store(&[
            ("w1", "T1", "a.txt", "的 是 了"),
            ("w2", "T2", "b.txt", "alpha beta"),
            ("w3", "T3", "c.txt", "alpha beta"),
        ]);
        let mut df_cache = TermDfCache::new();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let mk = |idx: u8, text: &str, score: f64| PoolCandidate {
            passage_id: PassageId::parse(&format!("p_{:016x}", idx)).unwrap(),
            work_id: WorkId::from_work_key(&format!("w{idx}")).unwrap(),
            title: "T".to_owned(),
            text: text.to_owned(),
            genuine_rrf_score: Some(0.1),
            matched_queries: Vec::new(),
            found_in_round: 0,
            retrieval_rank: idx as usize,
            jev_score: score,
            expansion_terms: Vec::new(),
            dpp_order: None,
        };

        let zero_scores = vec![mk(1, "alpha", 0.0), mk(2, "beta", 0.0)];
        let order_zero =
            rank_dpp_indices(&store, &mut df_cache, 3, &zero_scores, deadline).unwrap();
        assert_eq!(order_zero, vec![0, 1]);

        let dup_and_empty = vec![
            mk(1, "alpha beta", 0.9),
            mk(2, "alpha beta", 0.8),
            mk(3, "的 是 了", 0.7),
        ];
        let order_dup =
            rank_dpp_indices(&store, &mut df_cache, 3, &dup_and_empty, deadline).unwrap();
        assert_eq!(order_dup, vec![0, 2, 1]);
    }

    #[test]
    fn dpp_varied_frequency_symmetric_vectors_are_deterministic() {
        let words = [
            "amber", "birch", "cedar", "delta", "elm", "frost", "grove", "hazel", "iris", "jade",
            "kelp", "lime", "moss", "navy", "oak", "pine", "quartz", "reed", "sage", "teal",
            "umber", "violet", "willow", "xenon", "yellow", "zinc",
        ];
        let docs: Vec<(String, String, String, String)> = (0..5usize)
            .map(|i| {
                let shared: String = words
                    .iter()
                    .enumerate()
                    .map(|(j, w)| vec![*w; 1 + (j % 5)].join(" "))
                    .collect::<Vec<_>>()
                    .join(" ");
                let unique: String = (0..20usize)
                    .map(|j| {
                        format!(
                            "unique{}{}",
                            (b'a' + i as u8) as char,
                            (b'a' + j as u8) as char
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                (
                    format!("w{i}"),
                    format!("T{i}"),
                    format!("{i}.txt"),
                    format!("anchor {shared} {unique}"),
                )
            })
            .collect();
        let doc_refs: Vec<(&str, &str, &str, &str)> = docs
            .iter()
            .map(|(w, t, p, b)| (w.as_str(), t.as_str(), p.as_str(), b.as_str()))
            .collect();
        let (_dir, store) = build_sag2_test_store(&doc_refs);
        let mut df_cache = TermDfCache::new();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let candidates: Vec<PoolCandidate> = docs
            .iter()
            .enumerate()
            .map(|(i, (w, _, _, text))| PoolCandidate {
                passage_id: PassageId::parse(&format!("p_{:016x}", i + 1)).unwrap(),
                work_id: WorkId::from_work_key(w).unwrap(),
                title: format!("T{i}"),
                text: text.clone(),
                genuine_rrf_score: Some(0.016),
                matched_queries: vec!["anchor".to_owned()],
                found_in_round: 0,
                retrieval_rank: i,
                jev_score: 0.8,
                expansion_terms: Vec::new(),
                dpp_order: None,
            })
            .collect();

        let baseline = rank_dpp_indices(&store, &mut df_cache, 5, &candidates, deadline).unwrap();
        assert_eq!(baseline, vec![0, 1, 2, 3, 4]);
        for run in 0..40 {
            let order = rank_dpp_indices(&store, &mut df_cache, 5, &candidates, deadline).unwrap();
            assert_eq!(order, baseline, "DPP order drifted at run {run}");
        }
    }

    #[test]
    fn low_score_round0_stops_early_with_no_qualified_seeds() {
        let (_dir, mut store) = build_sag2_test_store(&[
            (
                "w_a",
                "Alpha",
                "a.txt",
                "lowscoreanchor bridgeword_only_in_seed",
            ),
            (
                "w_b",
                "Beta",
                "b.txt",
                "bridgeword_only_in_seed target_that_would_expand",
            ),
        ]);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut content_len = 0usize;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; content_len];
            reader.read_exact(&mut body).unwrap();
            let req_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let mut answers = serde_json::Map::new();
            for k in req_json["questions"].as_object().unwrap().keys() {
                answers.insert(k.clone(), serde_json::json!({"type": "noul", "noul": 0.20}));
            }
            let resp_body = serde_json::to_vec(&serde_json::json!({
                "model": "typesafe/jev-1.14",
                "answers": answers,
            }))
            .unwrap();
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                resp_body.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(&resp_body).unwrap();
            stream.flush().unwrap();
        });

        let mut env_map = HashMap::new();
        env_map.insert(
            "JEV_BASE_URL",
            format!("http://127.0.0.1:{}/decisions", addr.port()),
        );
        env_map.insert("JEV_API_KEY", "dummy-sentinel".to_owned());
        let cfg = ValidatedJevConfig::from_lookup(None, |k| env_map.get(k).cloned()).unwrap();

        let req = PreparedSearch::prepare(SearchRequest {
            queries: vec!["lowscoreanchor".to_owned()],
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

        let res = run_sag2(&mut store, &req, cfg).unwrap();
        srv.join().unwrap();
        assert_eq!(res.stop_reason, Sag2StopReason::NoQualifiedSeeds);
        assert_eq!(res.rounds_completed, 1);
        assert_eq!(res.calls.http_attempts, 1);
        assert_eq!(res.candidate_counts.seeds_selected, 0);
        assert_eq!(res.candidate_counts.expansion_terms_selected, 0);
        assert_eq!(res.candidate_counts.expansion_new_candidates, 0);
        assert_eq!(res.candidate_counts.second_pool, 0);
        assert_eq!(res.hits.len(), 1);
        assert_eq!(res.hits[0].work.work_key, "w_a");
        assert!(res.hits[0].dpp_order.is_some());
    }

    #[test]
    fn dpp_window_scales_with_limit_beyond_ten() {
        let mut docs: Vec<(String, String, String, String)> = (0..15usize)
            .map(|i| {
                (
                    format!("w_{i:02}"),
                    format!("Title {i:02}"),
                    format!("{i:02}.txt"),
                    format!("dppanchor distinct_{i:02}"),
                )
            })
            .collect();
        for j in 0..6usize {
            docs.push((
                format!("w_exp_{j:02}"),
                format!("Title Exp {j:02}"),
                format!("exp_{j:02}.txt"),
                format!("distinct_00 extra_hop_target_{j:02}"),
            ));
        }
        let doc_refs: Vec<(&str, &str, &str, &str)> = docs
            .iter()
            .map(|(w, t, p, b)| (w.as_str(), t.as_str(), p.as_str(), b.as_str()))
            .collect();
        let (_dir, mut store) = build_sag2_test_store(&doc_refs);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut content_len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_len];
                reader.read_exact(&mut body).unwrap();
                let req_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let mut answers = serde_json::Map::new();
                for k in req_json["questions"].as_object().unwrap().keys() {
                    answers.insert(k.clone(), serde_json::json!({"type": "noul", "noul": 0.65}));
                }
                let resp_body = serde_json::to_vec(&serde_json::json!({
                    "model": "typesafe/jev-1.14",
                    "answers": answers,
                }))
                .unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    resp_body.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&resp_body).unwrap();
                stream.flush().unwrap();
            }
        });

        let mut env_map = HashMap::new();
        env_map.insert(
            "JEV_BASE_URL",
            format!("http://127.0.0.1:{}/decisions", addr.port()),
        );
        env_map.insert("JEV_API_KEY", "dummy-sentinel".to_owned());
        let cfg = ValidatedJevConfig::from_lookup(None, |k| env_map.get(k).cloned()).unwrap();

        let req = PreparedSearch::prepare(SearchRequest {
            queries: vec!["dppanchor".to_owned()],
            match_mode: MatchMode::Any,
            limit: 15,
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

        let res = run_sag2(&mut store, &req, cfg).unwrap();
        srv.join().unwrap();
        assert_eq!(res.limits.dpp_top_k, 15);
        assert_eq!(res.hits.len(), 15);
        let dpp_orders: Vec<usize> = res
            .hits
            .iter()
            .map(|h| h.dpp_order.expect("all 15 hits must be DPP-ranked"))
            .collect();
        assert_eq!(dpp_orders, (1..=15).collect::<Vec<_>>());
    }
}
