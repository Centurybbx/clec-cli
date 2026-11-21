use std::env;
use std::io::{IsTerminal, Write};
use std::path::PathBuf;

use clap::error::ErrorKind as ClapErrorKind;
use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};

use crate::distribution::{NetworkPolicy, TransferPolicy};
use crate::domain::{
    CORPUS_FORMAT, ClecError, DEFAULT_MAX_BYTES, DICTIONARY_REVISION, DateYmd,
    EQUIVALENCE_REVISION, ErrorCode, ErrorEnvelope, NORMALIZATION_REVISION, PassageId, ReleaseHash,
    SCHEMA_VERSION, SEGMENTATION_REVISION, Sag2ErrorContext, Sag2Stage, SourceId, SourceRole,
    TOKENIZATION_REVISION, TypedRef, WorkId,
};
use crate::lexical::Normalization;
use crate::retrieval::{
    BudgetReport, DEFAULT_PER_WORK, DEFAULT_SEARCH_LIMIT, LeadPassage, MatchMode, PreparedSearch,
    SearchData, SearchLead, SearchQueryTerms, SearchRequest, execute_search, json_prefix,
    project_lead,
};
#[cfg(not(feature = "test-hooks"))]
use crate::sag2::run_sag2;
#[cfg(feature = "test-hooks")]
use crate::sag2::run_sag2_with_test_overrides;
use crate::sag2::{
    Sag2CallStats, Sag2CandidateCounts, Sag2Consumption, Sag2Limits, Sag2SearchData,
    Sag2StopReason, Sag2UsageProvenance, jev::ValidatedJevConfig, minimum_sag2_search_data,
};
use crate::snapshot::{
    StatusData, SyncData, SyncDryRunData, data_dir_status, ensure_current_store, sync_dry_run,
    sync_with_prepare,
};
use crate::store::{PassageReadItem, SourceListEntry, SourceOriginalItem, SourceOverviewItem};

pub(crate) const BUILTIN_DEFAULT_MANIFEST_URL: Option<&str> = None;

#[derive(Debug, Clone)]
pub(crate) struct RuntimeOptions {
    pub default_origin: Option<String>,
    pub transfer_policy: TransferPolicy,
    #[cfg(feature = "test-hooks")]
    pub jev_request_timeout: Option<std::time::Duration>,
}

impl RuntimeOptions {
    pub(crate) fn shipped() -> Self {
        Self {
            default_origin: BUILTIN_DEFAULT_MANIFEST_URL.map(ToOwned::to_owned),
            transfer_policy: TransferPolicy::shipped(),
            #[cfg(feature = "test-hooks")]
            jev_request_timeout: None,
        }
    }
}

#[cfg(feature = "test-hooks")]
#[derive(Debug, Clone)]
pub struct TestFixtureOptions {
    pub default_origin: Option<String>,
    pub connect_timeout_ms: Option<u64>,
    pub manifest_timeout_ms: Option<u64>,
    pub artifact_timeout_ms: Option<u64>,
    pub extra_root_pem: Option<Vec<u8>>,
    pub resolver_delay_ms: Option<u64>,
    pub resolver_delay_host: Option<String>,
    pub setup_delay_ms: Option<u64>,
    pub cleanup_delay_ms: Option<u64>,
    pub hook_log_path: Option<PathBuf>,
    pub jev_request_timeout_ms: Option<u64>,
}

#[derive(Debug, Parser)]
#[command(
    name = "clec",
    version,
    about = "CLEC evidence search, exact byte-span reads, and static snapshot sync",
    disable_help_subcommand = false
)]
struct Cli {
    /// Corpus data directory (defaults to CLEC_DATA_DIR, ~/.local/share/clec/native-v2 on Unix, or %LOCALAPPDATA%/clec/native-v2 on Windows)
    #[arg(long, global = true, value_name = "PATH")]
    pub data_dir: Option<PathBuf>,

    /// Emit JSON on stdout even in an interactive terminal
    #[arg(long, global = true)]
    pub json: bool,

    /// Forbid all HTTP network requests; allow local operations and local sync only
    #[arg(long, global = true)]
    pub offline: bool,

    /// Maximum UTF-8 byte budget for stdout output (including help and version)
    #[arg(long, global = true, default_value_t = DEFAULT_MAX_BYTES, value_name = "N")]
    pub max_bytes: usize,

    /// Enable explicit SAG2 one-hop Jev retrieval on `search` (conflicts with --offline)
    #[arg(long, global = true)]
    pub sag2: bool,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum MatchArg {
    Any,
    All,
}

impl From<MatchArg> for MatchMode {
    fn from(value: MatchArg) -> Self {
        match value {
            MatchArg::Any => Self::Any,
            MatchArg::All => Self::All,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum RoleArg {
    Transcript,
    Qa,
    Summary,
    Document,
}

impl From<RoleArg> for SourceRole {
    fn from(value: RoleArg) -> Self {
        match value {
            RoleArg::Transcript => Self::Transcript,
            RoleArg::Qa => Self::Qa,
            RoleArg::Summary => Self::Summary,
            RoleArg::Document => Self::Document,
        }
    }
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Verify and atomically activate a local or HTTPS release manifest
    Sync(SyncArgs),
    /// Find passage IDs and short original excerpts using 1 to 4 lexical queries
    Search(SearchArgs),
    /// Read exact passages (p_...) or original sources (s_... --original)
    Read(ReadArgs),
    /// List or filter works and sources in the active corpus
    Sources(SourcesArgs),
    /// Show data directory status without bootstrapping or network access
    Status,
    /// Output machine-readable CLI and response schema derived from parser and serde types
    Schema,
}

#[derive(Debug, Args)]
struct SyncArgs {
    /// Local path or HTTPS URL to publisher manifest.json
    #[arg(long, value_name = "PATH_OR_HTTPS_URL")]
    pub manifest: Option<String>,

    /// Validate manifest and report planned sync without downloading artifacts or modifying --data-dir
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
struct SearchArgs {
    /// 1 to 4 lexical queries (for --sag2, the first query is original_question and others are retrieval alternatives)
    #[arg(required = true, num_args = 1..=4, value_name = "QUERY")]
    pub queries: Vec<String>,

    /// Token matching mode within each query
    #[arg(long, value_enum, default_value_t = MatchArg::Any)]
    pub match_mode: MatchArg,

    /// Maximum returned passage leads (1..=50)
    #[arg(long, default_value_t = DEFAULT_SEARCH_LIMIT, value_name = "N")]
    pub limit: usize,

    /// Zero-based pagination offset for local search
    #[arg(long, default_value_t = 0, value_name = "N")]
    pub offset: usize,

    /// Preferred per-work diversity cap before backfill (1..=5)
    #[arg(long, default_value_t = DEFAULT_PER_WORK, value_name = "N")]
    pub per_work: usize,

    /// Filter by WorkId (w_...)
    #[arg(long, value_name = "WORK_ID")]
    pub work: Option<String>,

    /// Filter by SourceId (s_...)
    #[arg(long, value_name = "SOURCE_ID")]
    pub source: Option<String>,

    /// Filter by source role
    #[arg(long, value_enum)]
    pub role: Option<RoleArg>,

    /// Inclusive start date (YYYY-MM-DD; excludes unknown dates)
    #[arg(long, value_name = "YYYY-MM-DD")]
    pub date_from: Option<String>,

    /// Inclusive end date (YYYY-MM-DD; excludes unknown dates)
    #[arg(long, value_name = "YYYY-MM-DD")]
    pub date_to: Option<String>,

    /// Expected active release SHA-256
    #[arg(long, value_name = "SHA256")]
    pub release: Option<String>,

    /// Path to file containing Jev/OpenRouter bearer credential for `search --sag2` (overrides env)
    #[arg(long, value_name = "PATH")]
    pub key_file: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct ReadArgs {
    /// Typed PassageId (p_...) or SourceId (s_...) references
    #[arg(required = true, num_args = 1..=50, value_name = "ID")]
    pub ids: Vec<String>,

    /// Adjacent passages per side for PassageId reads (0..=2)
    #[arg(long, default_value_t = 0, value_name = "N")]
    pub context: usize,

    /// Include detailed subtitle cues for passages and their context
    #[arg(long)]
    pub cues: bool,

    /// Require the active release that produced these IDs
    #[arg(long, value_name = "SHA256")]
    pub release: Option<String>,

    /// Return verbatim original UTF-8 text for a SourceId (s_...)
    #[arg(long)]
    pub original: bool,

    /// Literal unnormalized substring search inside the read target
    #[arg(long, value_name = "LITERAL")]
    pub find: Option<String>,
}

#[derive(Debug, Args)]
struct SourcesArgs {
    /// Optional normalized filter terms across work/source title and path
    #[arg(value_name = "QUERY")]
    pub query: Option<String>,

    /// Filter by WorkId (w_...)
    #[arg(long, value_name = "WORK_ID")]
    pub work: Option<String>,

    /// Filter by source role
    #[arg(long, value_enum)]
    pub role: Option<RoleArg>,

    /// Return only canonical indexed sources (exclude collapsed duplicates)
    #[arg(long)]
    pub canonical_only: bool,

    /// Maximum sources returned (1..=100)
    #[arg(long, default_value_t = 50, value_name = "N")]
    pub limit: usize,

    /// Zero-based pagination offset
    #[arg(long, default_value_t = 0, value_name = "N")]
    pub offset: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SuccessEnvelope<T> {
    pub schema_version: u32,
    pub ok: bool,
    pub command: String,
    pub data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
enum ReadItem {
    Passage(Box<PassageReadItem>),
    SourceOriginal(SourceOriginalItem),
    SourceOverview(SourceOverviewItem),
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadData<'a> {
    pub release: &'a ReleaseHash,
    pub items: &'a [ReadItem],
    pub budget: ReadDeliveryBudget<'a>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadBudgetReport {
    pub max_bytes: usize,
    pub used_bytes: usize,
    pub omitted_count: usize,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadDeliveryBudget<'a> {
    #[serde(flatten)]
    pub size: ReadBudgetReport,
    pub omitted_ids: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_required_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SourcesData {
    pub release: ReleaseHash,
    pub total_matched: usize,
    pub offset: usize,
    pub limit: usize,
    pub items: Vec<SourceListEntry>,
    pub budget: ReadBudgetReport,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SchemaArgSpec {
    pub id: String,
    pub long: Option<String>,
    pub short: Option<String>,
    pub takes_value: bool,
    pub required: bool,
    pub possible_values: Vec<String>,
    pub default_values: Vec<String>,
    pub help: Option<String>,
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SchemaCommandSpec {
    pub name: String,
    pub about: Option<String>,
    pub supported: bool,
    pub options: Vec<SchemaArgSpec>,
    pub positionals: Vec<SchemaArgSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UnsupportedFeatureSpec {
    pub name: String,
    pub supported: bool,
    pub reason: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum SearchOutput {
    Local(SearchData),
    Sag2(Box<Sag2SearchOutput>),
}

#[derive(Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Sag2Lead {
    #[serde(flatten)]
    lead: SearchLead,
    jev_score: f64,
    dpp_order: Option<usize>,
    found_in_round: usize,
    matched_queries: Vec<String>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Sag2SearchOutput {
    #[serde(flatten)]
    search: SearchData<Sag2Lead>,
    algorithm: String,
    algorithm_revision: String,
    provider_verified: bool,
    requested_model: String,
    actual_model: Option<String>,
    rounds_completed: usize,
    stop_reason: Sag2StopReason,
    candidate_counts: Sag2CandidateCounts,
    calls: Sag2CallStats,
    limits: Sag2Limits,
    consumption: Sag2Consumption,
    usage: Sag2UsageProvenance,
}

impl Sag2SearchOutput {
    fn project(data: Sag2SearchData, normalization: Normalization) -> Result<Self, ClecError> {
        let hits = data
            .hits
            .into_iter()
            .map(|hit| {
                let time_range = hit
                    .cues
                    .iter()
                    .map(|cue| cue.start_ms)
                    .min()
                    .zip(hit.cues.iter().map(|cue| cue.end_ms).max());
                let lead = project_lead(
                    LeadPassage {
                        passage_id: hit.passage_id,
                        work: &hit.work,
                        source: &hit.source,
                        text: &hit.text,
                        spans: &hit.spans,
                        time_range,
                        continued_from: hit.continued_from,
                        continued_to: hit.continued_to,
                        rrf_score: hit.rrf_score,
                    },
                    &data.queries,
                    normalization,
                )?;
                Ok(Sag2Lead {
                    lead,
                    jev_score: hit.jev_score,
                    dpp_order: hit.dpp_order,
                    found_in_round: hit.found_in_round,
                    matched_queries: hit
                        .matched_queries
                        .iter()
                        .map(|query| json_prefix(query, 32).to_owned())
                        .collect(),
                })
            })
            .collect::<Result<_, ClecError>>()?;
        Ok(Self {
            search: SearchData {
                release: data.release,
                match_mode: data.match_mode,
                queries: data.queries,
                total_candidates: data.total_candidates,
                offset: data.offset,
                limit: data.limit,
                has_more: data.has_more,
                next_offset: None,
                hits,
                budget: data.budget,
            },
            algorithm: data.algorithm,
            algorithm_revision: data.algorithm_revision,
            provider_verified: data.provider_verified,
            requested_model: data.requested_model,
            actual_model: data.actual_model,
            rounds_completed: data.rounds_completed,
            stop_reason: data.stop_reason,
            candidate_counts: data.candidate_counts,
            calls: data.calls,
            limits: data.limits,
            consumption: data.consumption,
            usage: data.usage,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SchemaData {
    pub phase: String,
    pub binary: String,
    pub version: String,
    pub default_configured: bool,
    pub provider_verified: bool,
    pub corpus_format: String,
    pub segmentation_revision: String,
    pub tokenization_revision: String,
    pub normalization_revision: String,
    pub dictionary_revision: String,
    pub equivalence_revision: String,
    pub global_options: Vec<SchemaArgSpec>,
    pub commands: Vec<SchemaCommandSpec>,
    pub unsupported_features: Vec<UnsupportedFeatureSpec>,
    pub envelopes: serde_json::Value,
}

pub fn run_cli() -> i32 {
    let args: Vec<String> = env::args().collect();
    run_cli_with_args_and_options(&args, &RuntimeOptions::shipped())
}

#[cfg(feature = "test-hooks")]
pub fn run_cli_with_test_options(options: TestFixtureOptions) -> i32 {
    use std::time::Duration;

    let shipped = TransferPolicy::shipped();
    let runtime = RuntimeOptions {
        default_origin: options.default_origin,
        transfer_policy: TransferPolicy {
            connect_timeout: options
                .connect_timeout_ms
                .map_or(shipped.connect_timeout, Duration::from_millis),
            manifest_timeout: options
                .manifest_timeout_ms
                .map_or(shipped.manifest_timeout, Duration::from_millis),
            artifact_timeout: options
                .artifact_timeout_ms
                .map_or(shipped.artifact_timeout, Duration::from_millis),
            extra_root_pem: options.extra_root_pem,
        },
        jev_request_timeout: options.jev_request_timeout_ms.map(Duration::from_millis),
    };
    let _hooks_guard = crate::http_transport::install_fixture_hooks_guard(
        options.resolver_delay_ms,
        options.resolver_delay_host,
        options.setup_delay_ms,
        options.cleanup_delay_ms,
        options.hook_log_path,
    );
    let args: Vec<String> = env::args().collect();
    run_cli_with_args_and_options(&args, &runtime)
}

#[cfg(test)]
pub(crate) fn run_cli_with_args(args: &[String]) -> i32 {
    run_cli_with_args_and_options(args, &RuntimeOptions::shipped())
}

pub(crate) fn run_cli_with_args_and_options(args: &[String], options: &RuntimeOptions) -> i32 {
    let parsed = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(err) => match err.kind() {
            ClapErrorKind::DisplayHelp | ClapErrorKind::DisplayVersion => {
                let max_bytes = match parse_max_bytes_for_early_exit(args) {
                    Ok(n) => n,
                    Err(clec_err) => {
                        emit_error(&clec_err, None);
                        return clec_err.code.exit_code();
                    }
                };
                if max_bytes == 0 {
                    let clec_err = ClecError::new(
                        ErrorCode::OutputBudgetTooSmall,
                        "--max-bytes must be at least 1.",
                    );
                    emit_error(&clec_err, None);
                    return clec_err.code.exit_code();
                }
                let text = err.to_string();
                if text.len() > max_bytes {
                    let clec_err = ClecError::new(
                        ErrorCode::OutputBudgetTooSmall,
                        format!(
                            "Output requires {} UTF-8 bytes, exceeding --max-bytes {max_bytes}.",
                            text.len()
                        ),
                    );
                    emit_error(&clec_err, None);
                    return clec_err.code.exit_code();
                }
                let _ = write_stdout_safe(&text);
                return 0;
            }
            _ => {
                let clec_err = ClecError::new(
                    ErrorCode::InvalidArgument,
                    err.to_string().trim().to_owned(),
                );
                emit_error(&clec_err, None);
                return clec_err.code.exit_code();
            }
        },
    };

    let cmd_name = command_name(&parsed.command);
    if parsed.sag2 && !matches!(parsed.command, Commands::Search(_)) {
        let err = ClecError::new(
            ErrorCode::InvalidArgument,
            "--sag2 is only supported on `clec search`.",
        );
        emit_error(&err, Some(cmd_name));
        return err.code.exit_code();
    }

    if parsed.max_bytes == 0 {
        let err = ClecError::new(
            ErrorCode::OutputBudgetTooSmall,
            "--max-bytes must be at least 1.",
        );
        emit_error(&err, Some(cmd_name));
        return err.code.exit_code();
    }

    let use_json = parsed.json || !std::io::stdout().is_terminal();
    match dispatch(&parsed, use_json, options) {
        Ok(payload) => {
            let _ = write_stdout_safe(&payload);
            0
        }
        Err(err) => {
            emit_error(&err, Some(cmd_name));
            err.code.exit_code()
        }
    }
}

fn parse_max_bytes_for_early_exit(args: &[String]) -> Result<usize, ClecError> {
    let mut max_bytes = DEFAULT_MAX_BYTES;
    let mut i = 1usize;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            break;
        }
        if let Some(val) = arg.strip_prefix("--max-bytes=") {
            max_bytes = val.parse::<usize>().map_err(|_| {
                ClecError::new(
                    ErrorCode::InvalidArgument,
                    format!("Invalid value '{val}' for '--max-bytes <N>'."),
                )
            })?;
        } else if arg == "--max-bytes" {
            let next = args.get(i + 1).ok_or_else(|| {
                ClecError::new(
                    ErrorCode::InvalidArgument,
                    "a value is required for '--max-bytes <N>' but none was supplied",
                )
            })?;
            max_bytes = next.parse::<usize>().map_err(|_| {
                ClecError::new(
                    ErrorCode::InvalidArgument,
                    format!("Invalid value '{next}' for '--max-bytes <N>'."),
                )
            })?;
            i += 1;
        }
        i += 1;
    }
    Ok(max_bytes)
}

fn command_name(cmd: &Commands) -> &'static str {
    match cmd {
        Commands::Sync(_) => "sync",
        Commands::Search(_) => "search",
        Commands::Read(_) => "read",
        Commands::Sources(_) => "sources",
        Commands::Status => "status",
        Commands::Schema => "schema",
    }
}

fn non_empty_env<F>(get_env: &F, key: &str) -> Option<std::ffi::OsString>
where
    F: Fn(&str) -> Option<std::ffi::OsString>,
{
    get_env(key).filter(|val| !val.to_string_lossy().trim().is_empty())
}

#[cfg(any(not(windows), test))]
fn resolve_unix_data_dir_with<F>(get_env: &F) -> Result<PathBuf, ClecError>
where
    F: Fn(&str) -> Option<std::ffi::OsString>,
{
    let Some(home) = non_empty_env(get_env, "HOME") else {
        return Err(ClecError::new(
            ErrorCode::InvalidDataDir,
            "Cannot determine default data directory because HOME is unset or empty. Pass --data-dir PATH or set CLEC_DATA_DIR.",
        ));
    };
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("clec")
        .join("native-v2"))
}

#[cfg(any(windows, test))]
fn resolve_windows_data_dir_with<F>(get_env: &F) -> Result<PathBuf, ClecError>
where
    F: Fn(&str) -> Option<std::ffi::OsString>,
{
    if let Some(local_app_data) = non_empty_env(get_env, "LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data).join("clec").join("native-v2"));
    }
    if let Some(user_profile) = non_empty_env(get_env, "USERPROFILE") {
        return Ok(PathBuf::from(user_profile)
            .join("AppData")
            .join("Local")
            .join("clec")
            .join("native-v2"));
    }
    Err(ClecError::new(
        ErrorCode::InvalidDataDir,
        "Cannot determine default data directory because LOCALAPPDATA and USERPROFILE are unset or empty. Pass --data-dir PATH or set CLEC_DATA_DIR.",
    ))
}

fn resolve_data_dir_with_env<F>(
    explicit: Option<&PathBuf>,
    get_env: F,
) -> Result<PathBuf, ClecError>
where
    F: Fn(&str) -> Option<std::ffi::OsString>,
{
    if let Some(p) = explicit {
        if p.as_os_str().is_empty() {
            return Err(ClecError::new(
                ErrorCode::InvalidDataDir,
                "--data-dir must not be empty.",
            ));
        }
        return Ok(p.clone());
    }
    if let Some(env_dir) = non_empty_env(&get_env, "CLEC_DATA_DIR") {
        return Ok(PathBuf::from(env_dir));
    }
    #[cfg(windows)]
    {
        resolve_windows_data_dir_with(&get_env)
    }
    #[cfg(not(windows))]
    {
        resolve_unix_data_dir_with(&get_env)
    }
}

fn resolve_data_dir(explicit: Option<&PathBuf>) -> Result<PathBuf, ClecError> {
    resolve_data_dir_with_env(explicit, |k| env::var_os(k))
}

#[derive(Debug, Clone)]
enum PreparedReadTarget {
    Passage(PassageId),
    SourceOriginal(SourceId),
    SourceOverview(SourceId),
}

#[derive(Debug, Clone)]
struct PreparedRead {
    targets: Vec<PreparedReadTarget>,
    context: usize,
    find: Option<String>,
    cues: bool,
    release: Option<ReleaseHash>,
}

impl PreparedRead {
    fn prepare(args: &ReadArgs) -> Result<Self, ClecError> {
        if args.ids.is_empty() || args.ids.len() > 50 {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "Read requires 1..=50 typed references.",
            ));
        }
        if args.context > 2 {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "--context must be 0..=2.",
            ));
        }
        let mut targets = Vec::with_capacity(args.ids.len());
        for (idx, raw_id) in args.ids.iter().enumerate() {
            let parsed = TypedRef::parse(raw_id).map_err(|e| e.with_input_index(idx))?;
            match parsed {
                TypedRef::Passage(pid) => {
                    if args.original {
                        return Err(ClecError::new(
                            ErrorCode::InvalidArgument,
                            "--original requires a SourceId (s_...), not a PassageId.",
                        )
                        .with_input_index(idx));
                    }
                    targets.push(PreparedReadTarget::Passage(pid));
                }
                TypedRef::Source(sid) => {
                    if args.original {
                        targets.push(PreparedReadTarget::SourceOriginal(sid));
                    } else {
                        if args.find.is_some() {
                            return Err(ClecError::new(
                                ErrorCode::InvalidArgument,
                                "--find on a SourceId requires --original.",
                            )
                            .with_input_index(idx));
                        }
                        targets.push(PreparedReadTarget::SourceOverview(sid));
                    }
                }
            }
        }
        if let Some(needle) = args.find.as_deref()
            && (needle.is_empty() || needle.len() > 512 || needle.contains('\0'))
        {
            return Err(ClecError::new(
                ErrorCode::InvalidQuery,
                "Literal --find needle must be 1..512 UTF-8 bytes without NUL.",
            ));
        }
        Ok(Self {
            targets,
            context: args.context,
            find: args.find.clone(),
            cues: args.cues,
            release: args
                .release
                .as_deref()
                .map(ReleaseHash::parse)
                .transpose()?,
        })
    }
}

#[derive(Debug, Clone)]
struct PreparedSources {
    query: Option<String>,
    work_filter: Option<WorkId>,
    role_filter: Option<SourceRole>,
    canonical_only: bool,
    limit: usize,
    offset: usize,
}

impl PreparedSources {
    fn prepare(args: &SourcesArgs) -> Result<Self, ClecError> {
        if args.limit == 0 || args.limit > 100 {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "--limit for sources must be 1..=100.",
            ));
        }
        if let Some(q) = args.query.as_deref()
            && (q.len() > 512 || q.contains('\0'))
        {
            return Err(ClecError::new(
                ErrorCode::InvalidQuery,
                "Sources query must be at most 512 UTF-8 bytes without NUL.",
            ));
        }
        Ok(Self {
            query: args.query.clone(),
            work_filter: args.work.as_deref().map(WorkId::parse).transpose()?,
            role_filter: args.role.map(Into::into),
            canonical_only: args.canonical_only,
            limit: args.limit,
            offset: args.offset,
        })
    }
}

fn prepare_search_request(args: &SearchArgs) -> Result<PreparedSearch, ClecError> {
    let req = SearchRequest {
        queries: args.queries.clone(),
        match_mode: args.match_mode.into(),
        limit: args.limit,
        offset: args.offset,
        per_work: args.per_work,
        work_filter: args.work.as_deref().map(WorkId::parse).transpose()?,
        source_filter: args.source.as_deref().map(SourceId::parse).transpose()?,
        role_filter: args.role.map(Into::into),
        date_from: args.date_from.as_deref().map(DateYmd::parse).transpose()?,
        date_to: args.date_to.as_deref().map(DateYmd::parse).transpose()?,
        release_pin: args
            .release
            .as_deref()
            .map(ReleaseHash::parse)
            .transpose()?,
    };
    PreparedSearch::prepare(req)
}

enum SearchMode {
    Local,
    Sag2(ValidatedJevConfig),
}

fn authorize_search_mode(cli: &Cli, args: &SearchArgs) -> Result<SearchMode, ClecError> {
    if !cli.sag2 {
        if args.key_file.is_some() {
            return Err(ClecError::new(
                ErrorCode::InvalidArgument,
                "--key-file requires --sag2 on `clec search`.",
            ));
        }
        return Ok(SearchMode::Local);
    }
    if cli.offline {
        return Err(ClecError::new(
            ErrorCode::OfflineRequired,
            "--sag2 cannot be used with --offline; SAG2 requires Jev API requests.",
        ));
    }
    let config = ValidatedJevConfig::from_env_and_args(args.key_file.as_deref())?;
    Ok(SearchMode::Sag2(config))
}

fn dispatch(cli: &Cli, use_json: bool, options: &RuntimeOptions) -> Result<String, ClecError> {
    if cli.sag2 && !matches!(cli.command, Commands::Search(_)) {
        return Err(ClecError::new(
            ErrorCode::InvalidArgument,
            "--sag2 is only supported on `clec search`.",
        ));
    }

    let max_bytes = cli.max_bytes;
    let network_policy = if cli.offline {
        NetworkPolicy::Offline
    } else {
        NetworkPolicy::Allowed
    };
    let default_origin = options.default_origin.as_deref();

    match &cli.command {
        Commands::Schema => {
            let data = build_schema_data(default_origin.is_some());
            serialize_fixed("schema", &data, use_json, max_bytes, format_schema_text)
        }
        Commands::Status => {
            let data_dir = resolve_data_dir(cli.data_dir.as_ref())?;
            let data = data_dir_status(&data_dir)?;
            serialize_fixed("status", &data, use_json, max_bytes, format_status_text)
        }
        Commands::Sync(args) => {
            let data_dir = resolve_data_dir(cli.data_dir.as_ref())?;
            if args.dry_run {
                let data = sync_dry_run(
                    &data_dir,
                    args.manifest.as_deref(),
                    network_policy,
                    default_origin,
                    &options.transfer_policy,
                )?;
                return serialize_fixed(
                    "sync",
                    &data,
                    use_json,
                    max_bytes,
                    format_sync_dry_run_text,
                );
            }
            sync_with_prepare(
                &data_dir,
                args.manifest.as_deref(),
                network_policy,
                default_origin,
                &options.transfer_policy,
                |data| serialize_fixed("sync", data, use_json, max_bytes, format_sync_text),
            )
        }
        Commands::Search(args) => {
            if cli.sag2 && cli.offline {
                return Err(ClecError::new(
                    ErrorCode::OfflineRequired,
                    "--sag2 cannot be used with --offline; SAG2 requires Jev API requests.",
                ));
            }
            if !cli.sag2 && args.key_file.is_some() {
                return Err(ClecError::new(
                    ErrorCode::InvalidArgument,
                    "--key-file requires --sag2 on `clec search`.",
                ));
            }
            if cli.sag2 && args.offset > 0 {
                return Err(ClecError::new(
                    ErrorCode::InvalidArgument,
                    "--offset is only supported on local `clec search`; increase --limit (up to 50) for `--sag2`.",
                ));
            }
            let mut prepared = prepare_search_request(args)?;
            if cli.sag2 {
                let min_bytes = minimum_sag2_search_envelope_bytes(&prepared, use_json, max_bytes)?;
                if max_bytes < min_bytes {
                    return Err(ClecError::new(
                        ErrorCode::OutputBudgetTooSmall,
                        format!(
                            "The minimum search envelope needs {min_bytes} UTF-8 bytes. Retry with --max-bytes 32768 or higher."
                        ),
                    ));
                }
            }
            let mode = authorize_search_mode(cli, args)?;
            let data_dir = resolve_data_dir(cli.data_dir.as_ref())?;
            let mut store = ensure_current_store(
                &data_dir,
                network_policy,
                default_origin,
                &options.transfer_policy,
                None,
            )?;
            prepared.bind_normalization(store.normalization)?;
            match mode {
                SearchMode::Local => {
                    let full = execute_search(&store, &prepared)?;
                    fit_search_budget(SearchOutput::Local(full), use_json, max_bytes)
                }
                SearchMode::Sag2(jev_config) => {
                    #[cfg(feature = "test-hooks")]
                    let full = run_sag2_with_test_overrides(
                        &mut store,
                        &prepared,
                        jev_config,
                        options.transfer_policy.extra_root_pem.clone(),
                        options.jev_request_timeout,
                    )?;
                    #[cfg(not(feature = "test-hooks"))]
                    let full = run_sag2(&mut store, &prepared, jev_config)?;
                    fit_sag2_search_budget(full, prepared.normalization, use_json, max_bytes)
                }
            }
        }
        Commands::Sources(args) => {
            let prepared = PreparedSources::prepare(args)?;
            let data_dir = resolve_data_dir(cli.data_dir.as_ref())?;
            let store = ensure_current_store(
                &data_dir,
                network_policy,
                default_origin,
                &options.transfer_policy,
                None,
            )?;
            let matched = store.list_sources(
                prepared.query.as_deref(),
                prepared.work_filter.as_ref(),
                prepared.role_filter,
                prepared.canonical_only,
            )?;
            let total_matched = matched.len();
            let paged: Vec<SourceListEntry> = matched
                .into_iter()
                .skip(prepared.offset)
                .take(prepared.limit)
                .collect();
            let data = SourcesData {
                release: store.release,
                total_matched,
                offset: prepared.offset,
                limit: prepared.limit,
                items: paged,
                budget: ReadBudgetReport {
                    max_bytes,
                    used_bytes: 0,
                    omitted_count: 0,
                },
            };
            fit_sources_budget(data, use_json, max_bytes)
        }
        Commands::Read(args) => {
            let prepared = PreparedRead::prepare(args)?;
            let data_dir = resolve_data_dir(cli.data_dir.as_ref())?;
            let store = ensure_current_store(
                &data_dir,
                network_policy,
                default_origin,
                &options.transfer_policy,
                None,
            )?;
            if prepared
                .release
                .as_ref()
                .is_some_and(|release| release != &store.release)
            {
                return Err(ClecError::new(
                    ErrorCode::VersionUnavailable,
                    "Active release differs from requested --release.",
                ));
            }
            let mut items = Vec::with_capacity(prepared.targets.len());
            for (idx, target) in prepared.targets.iter().enumerate() {
                match target {
                    PreparedReadTarget::Passage(pid) => {
                        let item = store
                            .read_passage_with_cues(
                                pid,
                                prepared.context,
                                prepared.find.as_deref(),
                                prepared.cues,
                            )
                            .map_err(|e| e.with_input_index(idx))?;
                        items.push(ReadItem::Passage(Box::new(item)));
                    }
                    PreparedReadTarget::SourceOriginal(sid) => {
                        let item = store
                            .read_source_original(sid, prepared.find.as_deref())
                            .map_err(|e| e.with_input_index(idx))?;
                        items.push(ReadItem::SourceOriginal(item));
                    }
                    PreparedReadTarget::SourceOverview(sid) => {
                        let item = store
                            .read_source_overview(sid)
                            .map_err(|e| e.with_input_index(idx))?;
                        items.push(ReadItem::SourceOverview(item));
                    }
                }
            }
            fit_read_budget(&store.release, &items, &args.ids, use_json, max_bytes)
        }
    }
}

fn serialize_envelope<T: Serialize>(command: &str, data: &T) -> Result<String, ClecError> {
    let envelope = SuccessEnvelope {
        schema_version: SCHEMA_VERSION,
        ok: true,
        command: command.to_owned(),
        data,
    };
    let mut s = serde_json::to_string(&envelope).map_err(|e| {
        ClecError::new(
            ErrorCode::InternalError,
            format!("JSON serialization failed: {e}"),
        )
    })?;
    s.push('\n');
    Ok(s)
}

fn serialize_fixed<T: Serialize>(
    command: &str,
    data: &T,
    use_json: bool,
    max_bytes: usize,
    text_fn: impl Fn(&T) -> String,
) -> Result<String, ClecError> {
    let out = if use_json {
        serialize_envelope(command, data)?
    } else {
        text_fn(data)
    };
    if out.len() > max_bytes {
        return Err(ClecError::new(
            ErrorCode::OutputBudgetTooSmall,
            format!(
                "Output requires {} UTF-8 bytes, exceeding --max-bytes {max_bytes}.",
                out.len()
            ),
        ));
    }
    Ok(out)
}

fn converge_rendered_bytes<FRender>(
    keep: usize,
    render_with_keep: &mut FRender,
) -> Result<String, ClecError>
where
    FRender: FnMut(usize, usize) -> Result<String, ClecError>,
{
    let mut used_bytes = 0usize;
    for _ in 0..32 {
        let rendered = render_with_keep(keep, used_bytes)?;
        if rendered.len() == used_bytes {
            return Ok(rendered);
        }
        used_bytes = rendered.len();
    }
    Err(ClecError::new(
        ErrorCode::InternalError,
        "Output byte-count calculation failed to converge.",
    ))
}

fn fit_list_budget<FRender>(
    total: usize,
    min_keep: usize,
    max_bytes: usize,
    mut render_with_keep: FRender,
) -> Result<String, ClecError>
where
    FRender: FnMut(usize, usize) -> Result<String, ClecError>,
{
    for keep in (min_keep..=total).rev() {
        let final_out = converge_rendered_bytes(keep, &mut render_with_keep)?;
        if final_out.len() <= max_bytes {
            return Ok(final_out);
        }
    }
    Err(ClecError::new(
        ErrorCode::OutputBudgetTooSmall,
        format!("Output requires more than --max-bytes {max_bytes} UTF-8 bytes."),
    ))
}

fn required_budget(
    mut render: impl FnMut(usize, usize) -> Result<String, ClecError>,
) -> Result<usize, ClecError> {
    Ok(converge_rendered_bytes(0, &mut |_, bytes| render(bytes, bytes))?.len())
}

fn budget_error(required: usize, max_bytes: usize) -> ClecError {
    ClecError::new(
        ErrorCode::OutputBudgetTooSmall,
        format!("Output requires {required} UTF-8 bytes, exceeding --max-bytes {max_bytes}."),
    )
    .with_required_bytes(required)
}

fn format_search(output: &SearchOutput, use_json: bool) -> Result<String, ClecError> {
    if use_json {
        serialize_envelope("search", output)
    } else {
        Ok(match output {
            SearchOutput::Local(data) => format_search_text(data),
            SearchOutput::Sag2(data) => format_sag2_search_text(data),
        })
    }
}

fn minimum_sag2_search_envelope_bytes(
    prepared: &PreparedSearch,
    use_json: bool,
    max_bytes: usize,
) -> Result<usize, ClecError> {
    let mut data = minimum_sag2_search_data(prepared, max_bytes);
    // The real response may omit the query echo when it does not fit its own cap.
    data.queries.clear();
    let output = SearchOutput::Sag2(Box::new(Sag2SearchOutput::project(
        data,
        prepared.normalization,
    )?));
    Ok(format_search(&output, use_json)?.len())
}

fn cap_query_echo(queries: &mut Vec<SearchQueryTerms>) -> Result<(), ClecError> {
    let encoded_len = |queries: &[SearchQueryTerms]| {
        serde_json::to_vec(queries)
            .map(|bytes| bytes.len())
            .map_err(|error| {
                ClecError::new(
                    ErrorCode::InternalError,
                    format!("Query echo serialization failed: {error}"),
                )
            })
    };
    if encoded_len(queries)? > 2048 {
        for query in queries.iter_mut() {
            query.terms.clear();
        }
    }
    if encoded_len(queries)? > 2048 {
        queries.clear();
    }
    Ok(())
}

enum SearchHits {
    Local(Vec<SearchLead>),
    Sag2(Vec<Sag2Lead>),
}

fn render_search_keep(
    output: &mut SearchOutput,
    all_hits: &SearchHits,
    keep: usize,
    cap: usize,
    used_bytes: usize,
    use_json: bool,
) -> Result<String, ClecError> {
    match (&mut *output, all_hits) {
        (SearchOutput::Local(data), SearchHits::Local(all)) => {
            data.hits = all[..keep].to_vec();
            let omitted_ids: Vec<PassageId> =
                all[keep..].iter().map(|h| h.passage_id.clone()).collect();
            let returned_end = data.offset.saturating_add(keep);
            data.has_more = returned_end < data.total_candidates;
            data.next_offset = data.has_more.then_some(returned_end);
            data.budget = BudgetReport {
                max_bytes: cap,
                used_bytes,
                omitted_count: omitted_ids.len(),
                omitted_ids,
            };
        }
        (SearchOutput::Sag2(data), SearchHits::Sag2(all)) => {
            data.search.hits = all[..keep].to_vec();
            let omitted_ids: Vec<PassageId> = all[keep..]
                .iter()
                .map(|h| h.lead.passage_id.clone())
                .collect();
            let returned_end = data.search.offset.saturating_add(keep);
            data.search.has_more = returned_end < data.search.total_candidates;
            data.search.next_offset = None;
            data.search.budget = BudgetReport {
                max_bytes: cap,
                used_bytes,
                omitted_count: omitted_ids.len(),
                omitted_ids,
            };
        }
        _ => unreachable!("SearchOutput and SearchHits variants always match"),
    }
    format_search(output, use_json)
}

fn fit_search_budget(
    mut output: SearchOutput,
    use_json: bool,
    max_bytes: usize,
) -> Result<String, ClecError> {
    match &mut output {
        SearchOutput::Local(data) => cap_query_echo(&mut data.queries)?,
        SearchOutput::Sag2(data) => cap_query_echo(&mut data.search.queries)?,
    }
    let (total, all_hits) = match &mut output {
        SearchOutput::Local(data) => {
            let hits = std::mem::take(&mut data.hits);
            (hits.len(), SearchHits::Local(hits))
        }
        SearchOutput::Sag2(data) => {
            let hits = std::mem::take(&mut data.search.hits);
            (hits.len(), SearchHits::Sag2(hits))
        }
    };
    let full = converge_rendered_bytes(total, &mut |k, used| {
        render_search_keep(&mut output, &all_hits, k, max_bytes, used, use_json)
    })?;
    if full.len() <= max_bytes {
        return Ok(full);
    }
    if total <= 1 {
        let required = required_budget(|cap, used| {
            render_search_keep(&mut output, &all_hits, total, cap, used, use_json)
        })?;
        return Err(budget_error(required, max_bytes));
    }
    let min_keep = 1usize;
    let first = converge_rendered_bytes(min_keep, &mut |k, used| {
        render_search_keep(&mut output, &all_hits, k, max_bytes, used, use_json)
    })?;
    if first.len() > max_bytes {
        let required = required_budget(|cap, used| {
            render_search_keep(&mut output, &all_hits, min_keep, cap, used, use_json)
        })?;
        return Err(budget_error(required, max_bytes));
    }
    for keep in (min_keep..total).rev() {
        if keep == min_keep {
            return Ok(first);
        }
        let out = converge_rendered_bytes(keep, &mut |k, used| {
            render_search_keep(&mut output, &all_hits, k, max_bytes, used, use_json)
        })?;
        if out.len() <= max_bytes {
            return Ok(out);
        }
    }
    Ok(first)
}

fn fit_sag2_search_budget(
    data: Sag2SearchData,
    normalization: Normalization,
    use_json: bool,
    max_bytes: usize,
) -> Result<String, ClecError> {
    let stage_ctx = Sag2ErrorContext {
        completed_stage: Sag2Stage::OutputBudget,
        rounds_completed: data.rounds_completed,
        http_attempts: data.calls.http_attempts,
        successful_batches: data.calls.successful_batches,
        scored_occurrences: data.candidate_counts.scored_occurrences,
        sql_candidate_queries: data.calls.sql_candidate_queries,
        df_lookups_distinct: data.calls.df_lookups_distinct,
        request_bytes: data.consumption.request_bytes,
        response_bytes: data.consumption.response_bytes,
        estimated_token_units: data.consumption.estimated_token_units,
    };
    Sag2SearchOutput::project(data, normalization)
        .and_then(|data| fit_search_budget(SearchOutput::Sag2(Box::new(data)), use_json, max_bytes))
        .map_err(|err| err.with_sag2_stage(stage_ctx))
}

fn fit_sources_budget(
    mut data: SourcesData,
    use_json: bool,
    max_bytes: usize,
) -> Result<String, ClecError> {
    let all_items = std::mem::take(&mut data.items);
    let total = all_items.len();
    let min_keep = usize::from(total > 0);
    fit_list_budget(total, min_keep, max_bytes, |keep, used_bytes| {
        data.items = all_items[..keep].to_vec();
        data.budget = ReadBudgetReport {
            max_bytes,
            used_bytes,
            omitted_count: total - keep,
        };
        if use_json {
            serialize_envelope("sources", &data)
        } else {
            Ok(format_sources_text(&data))
        }
    })
}

fn render_read(
    release: &ReleaseHash,
    items: &[ReadItem],
    omitted_ids: &[String],
    next_required_bytes: Option<usize>,
    use_json: bool,
    max_bytes: usize,
    used_bytes: usize,
) -> Result<String, ClecError> {
    let data = ReadData {
        release,
        items,
        budget: ReadDeliveryBudget {
            size: ReadBudgetReport {
                max_bytes,
                used_bytes,
                omitted_count: omitted_ids.len(),
            },
            omitted_ids,
            next_required_bytes,
        },
    };
    if use_json {
        serialize_envelope("read", &data)
    } else {
        Ok(format_read_text(&data))
    }
}

fn fit_read_budget(
    release: &ReleaseHash,
    items: &[ReadItem],
    ids: &[String],
    use_json: bool,
    max_bytes: usize,
) -> Result<String, ClecError> {
    let total = items.len();
    let single_required = |index| {
        required_budget(|cap, used| {
            render_read(
                release,
                &items[index..index + 1],
                &[],
                None,
                use_json,
                cap,
                used,
            )
        })
    };
    for keep in (1..=total).rev() {
        let next_required = if keep < total {
            Some(single_required(keep)?)
        } else {
            None
        };
        let output = converge_rendered_bytes(keep, &mut |_, used| {
            render_read(
                release,
                &items[..keep],
                &ids[keep..],
                next_required,
                use_json,
                max_bytes,
                used,
            )
        })?;
        if output.len() <= max_bytes {
            return Ok(output);
        }
    }
    let required = if total == 1 {
        single_required(0)?
    } else {
        let next = Some(single_required(1)?);
        required_budget(|cap, used| {
            render_read(release, &items[..1], &ids[1..], next, use_json, cap, used)
        })?
    };
    Err(budget_error(required, max_bytes))
}

fn emit_error(err: &ClecError, command: Option<&str>) {
    let env = ErrorEnvelope::from_error(err, command);
    let json = serde_json::to_string(&env).unwrap_or_else(|_| {
        "{\"schemaVersion\":1,\"ok\":false,\"command\":null,\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Failed to serialize error\",\"remedy\":\"Retry\",\"next\":\"clec status\"}}\n".to_owned()
    });
    let _ = writeln!(std::io::stderr(), "{json}");
}

fn write_stdout_safe(text: &str) -> std::io::Result<()> {
    let mut out = std::io::stdout().lock();
    match out.write_all(text.as_bytes()) {
        Ok(()) => out.flush(),
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        Err(e) => Err(e),
    }
}

fn build_schema_data(default_configured: bool) -> SchemaData {
    let cmd = Cli::command();
    let global_options: Vec<SchemaArgSpec> = cmd
        .get_arguments()
        .filter(|a| a.is_global_set() && a.get_id() != "help" && a.get_id() != "version")
        .map(arg_to_spec)
        .collect();

    let commands: Vec<SchemaCommandSpec> = cmd
        .get_subcommands()
        .filter(|sub| sub.get_name() != "help")
        .map(|sub| {
            let options = sub
                .get_arguments()
                .filter(|a| !a.is_positional() && !a.is_global_set())
                .map(arg_to_spec)
                .collect();
            let positionals = sub
                .get_arguments()
                .filter(|a| a.is_positional())
                .map(arg_to_spec)
                .collect();
            SchemaCommandSpec {
                name: sub.get_name().to_owned(),
                about: sub.get_about().map(ToString::to_string),
                supported: true,
                options,
                positionals,
            }
        })
        .collect();

    let envelopes = serde_json::json!({
        "sync": schema_for!(SuccessEnvelope<SyncData>),
        "syncDryRun": schema_for!(SuccessEnvelope<SyncDryRunData>),
        "status": schema_for!(SuccessEnvelope<StatusData>),
        "search": schema_for!(SuccessEnvelope<SearchOutput>),
        "read": schema_for!(SuccessEnvelope<ReadData<'_>>),
        "sources": schema_for!(SuccessEnvelope<SourcesData>),
        "error": schema_for!(ErrorEnvelope),
    });

    SchemaData {
        phase: "phase5".to_owned(),
        binary: cmd.get_name().to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        default_configured,
        provider_verified: false,
        corpus_format: CORPUS_FORMAT.to_owned(),
        segmentation_revision: SEGMENTATION_REVISION.to_owned(),
        tokenization_revision: TOKENIZATION_REVISION.to_owned(),
        normalization_revision: NORMALIZATION_REVISION.to_owned(),
        dictionary_revision: DICTIONARY_REVISION.to_owned(),
        equivalence_revision: EQUIVALENCE_REVISION.to_owned(),
        global_options,
        commands,
        unsupported_features: Vec::new(),
        envelopes,
    }
}

fn arg_to_spec(arg: &clap::Arg) -> SchemaArgSpec {
    let possible_values = arg
        .get_possible_values()
        .into_iter()
        .map(|pv| pv.get_name().to_owned())
        .collect();
    let default_values = arg
        .get_default_values()
        .iter()
        .map(|os| os.to_string_lossy().into_owned())
        .collect();
    let id = arg.get_id().as_str().to_owned();
    SchemaArgSpec {
        supported: true,
        id,
        long: arg.get_long().map(|s| format!("--{s}")),
        short: arg.get_short().map(|c| format!("-{c}")),
        takes_value: arg.get_action().takes_values(),
        required: arg.is_required_set(),
        possible_values,
        default_values,
        help: arg.get_help().map(ToString::to_string),
    }
}

fn format_status_text(d: &StatusData) -> String {
    let mut lines = vec![
        format!("Ready: {}", d.ready),
        format!("Offline: {}", d.offline),
        format!("Data dir: {}", d.data_dir),
        format!(
            "Release: {}",
            d.active_release
                .as_ref()
                .map_or("none", ReleaseHash::as_str)
        ),
        format!("Storage bytes: {}", d.storage_bytes),
    ];
    if let Some(c) = &d.counts {
        lines.push(format!(
            "Counts: works={}, sources={}, canonicalSources={}, blobs={}, passages={}, cues={}, inventory={}",
            c.works, c.sources, c.canonical_sources, c.blobs, c.passages, c.cues, c.inventory
        ));
    }
    lines.join("\n") + "\n"
}

fn format_sync_text(d: &SyncData) -> String {
    format!(
        "Release: {}\nFormat: {}\nReused: {}\nWorks: {}, Sources: {}, Canonical: {}, Passages: {}\n",
        d.release,
        d.corpus_format,
        d.reused,
        d.counts.works,
        d.counts.sources,
        d.counts.canonical_sources,
        d.counts.passages
    )
}

fn format_sync_dry_run_text(d: &SyncDryRunData) -> String {
    format!(
        "Dry run: {}\nOrigin: {}\nRelease: {}\nFormat: {}\nActive: {}\nBytes: {}, Compressed: {}\nWorks: {}, Sources: {}, Canonical: {}, Passages: {}\n",
        d.dry_run,
        d.manifest_path,
        d.release,
        d.corpus_format,
        d.is_active,
        d.bytes,
        d.compressed_bytes,
        d.counts.works,
        d.counts.sources,
        d.counts.canonical_sources,
        d.counts.passages
    )
}

fn format_search_text(d: &SearchData) -> String {
    let next_part = d
        .next_offset
        .map_or_else(String::new, |next| format!("; Next offset: {next}"));
    let mut out = format!(
        "Release: {}\nCandidates: {}; Offset: {}; Returned: {}; Omitted by budget: {}{}\n\n",
        d.release,
        d.total_candidates,
        d.offset,
        d.hits.len(),
        d.budget.omitted_count,
        next_part
    );
    for hit in &d.hits {
        out.push_str(&format!(
            "[{}] {} ({}) score={:.6}\n{}\n\n",
            hit.passage_id,
            hit.source.title,
            hit.source.source_id,
            hit.rrf_score.unwrap_or_default(),
            hit.excerpt
        ));
    }
    out
}

fn format_sag2_search_text(d: &Sag2SearchOutput) -> String {
    let mut out = format!(
        "Mode: sag2 ({})\nRelease: {}\nStop: {:?}; Rounds: {}; HTTP attempts: {}; Returned: {}; Omitted by budget: {}\n\n",
        d.algorithm,
        d.search.release,
        d.stop_reason,
        d.rounds_completed,
        d.calls.http_attempts,
        d.search.hits.len(),
        d.search.budget.omitted_count
    );
    for hit in &d.search.hits {
        let rrf = hit
            .lead
            .rrf_score
            .map_or_else(|| "none".to_owned(), |v| format!("{v:.6}"));
        out.push_str(&format!(
            "[{}] {} ({}) jev={:.6} rrf={}\n{}\n\n",
            hit.lead.passage_id,
            hit.lead.source.title,
            hit.lead.source.source_id,
            hit.jev_score,
            rrf,
            hit.lead.excerpt
        ));
    }
    out
}

fn format_sources_text(d: &SourcesData) -> String {
    let mut out = format!(
        "Release: {}\nMatched: {}; Showing: {}; Omitted: {}\n\n",
        d.release,
        d.total_matched,
        d.items.len(),
        d.budget.omitted_count
    );
    for item in &d.items {
        out.push_str(&format!(
            "{} | {} | {} | {} | passages={}\n",
            item.work_id,
            item.source_id,
            item.role.as_str(),
            item.title,
            item.passage_count
        ));
    }
    out
}

fn format_read_text(d: &ReadData<'_>) -> String {
    let mut out = format!("Release: {}\n\n", d.release);
    for item in d.items {
        match item {
            ReadItem::Passage(p) => {
                out.push_str(&format!(
                    "Passage: {} (source: {}, work: {})\n{}\n\n",
                    p.passage_id, p.source.source_id, p.work.work_id, p.text
                ));
            }
            ReadItem::SourceOriginal(s) => {
                out.push_str(&format!(
                    "Source: {} ({} bytes)\n{}\n\n",
                    s.source.source_id, s.byte_len, s.original_text
                ));
            }
            ReadItem::SourceOverview(s) => {
                out.push_str(&format!(
                    "Source: {} (passages={}, cues={})\n",
                    s.source.source_id, s.passage_count, s.cue_count
                ));
            }
        }
    }
    if let Some(bytes) = d.budget.next_required_bytes {
        out.push_str(&format!(
            "Omitted IDs: {}\nRead the first omitted ID with the same read options, --release {} and --max-bytes {bytes}.\n",
            d.budget.omitted_ids.join(" "), d.release
        ));
    }
    out
}

fn format_schema_text(d: &SchemaData) -> String {
    serde_json::to_string_pretty(d).unwrap_or_default() + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_derives_directly_from_clap_and_serde() {
        let schema = build_schema_data(false);
        assert_eq!(schema.phase, "phase5");
        assert!(!schema.default_configured);
        assert!(!schema.provider_verified);
        assert_eq!(schema.corpus_format, CORPUS_FORMAT);
        assert!(schema.commands.iter().any(|c| c.name == "search"));
        assert!(schema.commands.iter().any(|c| c.name == "sync"));
        assert!(schema.commands.iter().any(|c| c.name == "read"));
        assert!(schema.commands.iter().any(|c| c.name == "sources"));
        assert!(schema.commands.iter().any(|c| c.name == "status"));
        assert!(schema.commands.iter().any(|c| c.name == "schema"));
        let sag2 = schema
            .global_options
            .iter()
            .find(|o| o.id == "sag2")
            .unwrap();
        assert!(sag2.supported);
        assert!(schema.unsupported_features.is_empty());

        let env_json = serde_json::to_string(&schema.envelopes).unwrap();
        assert!(env_json.contains("syncDryRun"));
        assert!(env_json.contains("sag2Stage"));
        assert!(env_json.contains("\"sag2\""));
        assert!(env_json.contains("^w_[0-9a-f]{16,64}$"));
        assert!(env_json.contains("^s_[0-9a-f]{16,64}$"));
        assert!(env_json.contains("^p_[0-9a-f]{16,64}$"));
        assert!(env_json.contains("^[0-9a-f]{64}$"));
        assert!(env_json.contains("^\\\\d{4}-\\\\d{2}-\\\\d{2}$"));
    }

    #[test]
    fn clap_disables_fuzzy_suggestions_on_unknown_command() {
        let err = Cli::try_parse_from(["clec", "serch"]).unwrap_err();
        let msg = err.to_string();
        assert!(!msg.contains("similar"));
        assert!(!msg.contains("Did you mean"));
    }

    #[test]
    fn max_bytes_enforced_consistently_on_help_and_version() {
        assert_eq!(
            run_cli_with_args(&[
                "clec".to_owned(),
                "--max-bytes".to_owned(),
                "1".to_owned(),
                "--help".to_owned(),
            ]),
            ErrorCode::OutputBudgetTooSmall.exit_code()
        );
        assert_eq!(
            run_cli_with_args(&[
                "clec".to_owned(),
                "--max-bytes=1".to_owned(),
                "--version".to_owned(),
            ]),
            ErrorCode::OutputBudgetTooSmall.exit_code()
        );
        assert_eq!(
            run_cli_with_args(&[
                "clec".to_owned(),
                "--max-bytes".to_owned(),
                "0".to_owned(),
                "--help".to_owned(),
            ]),
            ErrorCode::OutputBudgetTooSmall.exit_code()
        );
        assert_eq!(
            run_cli_with_args(&[
                "clec".to_owned(),
                "--max-bytes".to_owned(),
                "65536".to_owned(),
                "--help".to_owned(),
            ]),
            0
        );
    }

    #[test]
    fn budget_used_bytes_converges_to_exact_stdout_len_across_decimal_and_escaping_boundaries() {
        use crate::domain::{Attribution, ByteSpan, EquivalenceBasis};
        use crate::retrieval::{SearchSource, SearchWork};

        let release = ReleaseHash::parse(&"a".repeat(64)).unwrap();
        let wid = WorkId::from_work_key("demo").unwrap();
        let sid = SourceId::parse(&format!("s_{}", "1".repeat(24))).unwrap();
        let pid1 = PassageId::parse(&format!("p_{}", "2".repeat(24))).unwrap();
        let pid2 = PassageId::parse(&format!("p_{}", "3".repeat(24))).unwrap();

        for pad in 410..=425 {
            let title = format!("Demo{}\n\"\\😀\u{001f}", ".".repeat(pad));
            let data = SourcesData {
                release: release.clone(),
                total_matched: 1,
                offset: 0,
                limit: 1,
                items: vec![SourceListEntry {
                    work_id: wid.clone(),
                    work_key: "demo".to_owned(),
                    work_title: "Demo".to_owned(),
                    source_id: sid.clone(),
                    path: "a.txt".to_owned(),
                    title,
                    role: SourceRole::Transcript,
                    attribution: Attribution::AuthoredFixture,
                    quality: "fixture".to_owned(),
                    date: None,
                    date_basis: None,
                    content_hash: "b".repeat(64),
                    canonical_source_id: sid.clone(),
                    is_canonical: true,
                    equivalence_basis: EquivalenceBasis::UniqueInWorkRole,
                    equivalent_count: 1,
                    passage_count: 1,
                    diagnostics_count: 0,
                }],
                budget: ReadBudgetReport {
                    max_bytes: DEFAULT_MAX_BYTES,
                    used_bytes: 0,
                    omitted_count: 0,
                },
            };
            let out = fit_sources_budget(data.clone(), true, DEFAULT_MAX_BYTES).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
            assert_eq!(
                parsed["data"]["budget"]["usedBytes"].as_u64().unwrap() as usize,
                out.len(),
                "mismatch at pad={pad}"
            );

            let out_4digit_cap = fit_sources_budget(data.clone(), true, 2000).unwrap();
            let cap_len = out_4digit_cap.len();
            let exact = fit_sources_budget(data.clone(), true, cap_len).unwrap();
            let exact_parsed: serde_json::Value = serde_json::from_str(&exact).unwrap();
            assert_eq!(exact.len(), cap_len);
            assert_eq!(
                exact_parsed["data"]["budget"]["usedBytes"]
                    .as_u64()
                    .unwrap() as usize,
                exact.len()
            );
            let too_tight = fit_sources_budget(data, true, cap_len - 1).unwrap_err();
            assert_eq!(too_tight.code, ErrorCode::OutputBudgetTooSmall);
        }

        let make_hit = |pid: &PassageId, text: String| SearchLead {
            passage_id: pid.clone(),
            work: SearchWork {
                work_id: wid.clone(),
                work_key: "demo".to_owned(),
                family_key: None,
            },
            source: SearchSource {
                source_id: sid.clone(),
                title: "Demo".to_owned(),
                role: SourceRole::Document,
                attribution: Attribution::AuthoredFixture,
                date: None,
                date_basis: None,
            },
            excerpt_span: ByteSpan::new(0, text.len(), None).unwrap(),
            excerpt: text,
            time_range: None,
            continued_from: None,
            continued_to: None,
            rrf_score: Some(0.5),
        };

        let search_data = SearchData {
            release,
            match_mode: MatchMode::Any,
            queries: vec![SearchQueryTerms {
                query: "alpha".to_owned(),
                terms: vec!["alpha".to_owned()],
            }],
            total_candidates: 2,
            offset: 0,
            limit: 2,
            has_more: false,
            next_offset: None,
            hits: vec![
                make_hit(&pid1, "a".repeat(8600)),
                make_hit(&pid2, "b".repeat(800)),
            ],
            budget: BudgetReport {
                max_bytes: 10_005,
                used_bytes: 0,
                omitted_count: 0,
                omitted_ids: Vec::new(),
            },
        };
        let full_search =
            fit_search_budget(SearchOutput::Local(search_data.clone()), true, 65_536).unwrap();
        let full_parsed: serde_json::Value = serde_json::from_str(&full_search).unwrap();
        assert!(full_search.len() > 10_000);
        assert_eq!(
            full_parsed["data"]["budget"]["usedBytes"].as_u64().unwrap() as usize,
            full_search.len()
        );

        let truncated = fit_search_budget(
            SearchOutput::Local(search_data.clone()),
            true,
            full_search.len() - 1,
        )
        .unwrap();
        assert!(truncated.len() <= full_search.len() - 1);
        let trunc_parsed: serde_json::Value = serde_json::from_str(&truncated).unwrap();
        assert_eq!(trunc_parsed["data"]["hits"].as_array().unwrap().len(), 1);
        assert_eq!(trunc_parsed["data"]["budget"]["omittedCount"], 1);
        assert_eq!(
            trunc_parsed["data"]["budget"]["omittedIds"],
            serde_json::json!([pid2.as_str()])
        );
        assert_eq!(trunc_parsed["data"]["hasMore"], true);
        assert_eq!(trunc_parsed["data"]["nextOffset"], 1);
        assert_eq!(
            trunc_parsed["data"]["budget"]["usedBytes"].as_u64().unwrap() as usize,
            truncated.len()
        );

        let re_fit =
            fit_search_budget(SearchOutput::Local(search_data.clone()), true, truncated.len())
                .unwrap();
        let too_small = fit_search_budget(
            SearchOutput::Local(search_data.clone()),
            true,
            re_fit.len() - 1,
        )
        .unwrap_err();
        assert_eq!(too_small.code, ErrorCode::OutputBudgetTooSmall);
        let required = too_small.required_bytes.unwrap();
        assert_eq!(required, re_fit.len());
        let exact =
            fit_search_budget(SearchOutput::Local(search_data.clone()), true, required).unwrap();
        assert_eq!(exact.len(), required);

        let plain_search =
            fit_search_budget(SearchOutput::Local(search_data), false, full_search.len()).unwrap();
        assert!(plain_search.contains(&"a".repeat(8600)));
    }

    #[test]
    fn store_independent_validation_fails_before_opening_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent_dir = tmp.path().join("never_created");
        let dir_arg = nonexistent_dir.display().to_string();

        let cases: &[(&[&str], ErrorCode)] = &[
            (
                &["clec", "--data-dir", &dir_arg, "search", "   "],
                ErrorCode::InvalidQuery,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "valid",
                    "--limit",
                    "51",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "valid",
                    "--sag2",
                    "--offset",
                    "1",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "valid",
                    "--per-work",
                    "0",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "valid",
                    "--date-from",
                    "2025-05-02",
                    "--date-to",
                    "2025-05-01",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "valid",
                    "--work",
                    "bad",
                ],
                ErrorCode::InvalidReference,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "valid",
                    "--release",
                    "short",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &["clec", "--data-dir", &dir_arg, "read", "bad_ref"],
                ErrorCode::InvalidReference,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "read",
                    "p_0123456789abcdef",
                    "--original",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "read",
                    "s_0123456789abcdef",
                    "--find",
                    "x",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "read",
                    "p_0123456789abcdef",
                    "--context",
                    "3",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "read",
                    "p_0123456789abcdef",
                    "--find",
                    "",
                ],
                ErrorCode::InvalidQuery,
            ),
            (
                &["clec", "--data-dir", &dir_arg, "sources", "--limit", "101"],
                ErrorCode::InvalidArgument,
            ),
            (
                &["clec", "--data-dir", &dir_arg, "sources", "--work", "bad"],
                ErrorCode::InvalidReference,
            ),
            (
                &["clec", "--data-dir", &dir_arg, "sources", &"a".repeat(513)],
                ErrorCode::InvalidQuery,
            ),
        ];

        for (argv, expected_code) in cases {
            let owned: Vec<String> = argv.iter().map(|s| (*s).to_owned()).collect();
            let cli = Cli::try_parse_from(&owned).unwrap();
            let err = dispatch(&cli, true, &RuntimeOptions::shipped()).unwrap_err();
            assert_eq!(err.code, *expected_code, "argv={argv:?}");
        }
        assert!(!nonexistent_dir.exists());
    }

    #[test]
    fn cold_bootstrap_dry_run_and_lock_recheck_behave_per_contract() {
        use std::fs::{self, OpenOptions};
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::thread;

        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), "0050 cold bootstrap fixture body").unwrap();
        let intake = tmp.path().join("intake.json");
        fs::write(
            &intake,
            r#"{"schemaVersion":1,"works":[{"key":"w1","title":"W1"}],"sources":[{"work":"w1","path":"a.txt","title":"A","role":"document","attribution":"authored_fixture","quality":"fixture","status":"ready"}]}"#,
        )
        .unwrap();
        let rel = tmp.path().join("rel");
        let manifest = crate::snapshot::publish_release(&ws, &intake, &rel).unwrap();
        let manifest_bytes = fs::read(rel.join("manifest.json")).unwrap();
        let zst_bytes = fs::read(rel.join("corpus.sqlite.zst")).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let manifest_gets = Arc::new(AtomicUsize::new(0));
        let artifact_gets = Arc::new(AtomicUsize::new(0));
        let mg = Arc::clone(&manifest_gets);
        let ag = Arc::clone(&artifact_gets);
        let m_srv = manifest_bytes.clone();
        let z_srv = zst_bytes.clone();

        let srv = thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" || h == "\n" {
                        break;
                    }
                }
                if path == "/shutdown" {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
                    break;
                } else if path == "/manifest.json" {
                    mg.fetch_add(1, Ordering::SeqCst);
                    let head =
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", m_srv.len());
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&m_srv);
                } else if path == "/corpus.sqlite.zst" {
                    ag.fetch_add(1, Ordering::SeqCst);
                    let head =
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", z_srv.len());
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&z_srv);
                } else {
                    let _ =
                        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                }
            }
        });

        let default_url = format!("http://127.0.0.1:{port}/manifest.json");
        let opts = RuntimeOptions {
            default_origin: Some(default_url.clone()),
            transfer_policy: TransferPolicy::shipped(),
            #[cfg(feature = "test-hooks")]
            jev_request_timeout: None,
        };

        let dry_dir = tmp.path().join("dry_data");
        let dry_cli = Cli::try_parse_from([
            "clec",
            "--data-dir",
            &dry_dir.display().to_string(),
            "sync",
            "--dry-run",
        ])
        .unwrap();
        let dry_out = dispatch(&dry_cli, true, &opts).unwrap();
        let dry_val: serde_json::Value = serde_json::from_str(&dry_out).unwrap();
        assert_eq!(dry_val["data"]["dryRun"], true);
        assert_eq!(dry_val["data"]["isActive"], false);
        assert_eq!(dry_val["data"]["release"], manifest.sha256.as_str());
        assert!(!dry_dir.exists());
        assert_eq!(manifest_gets.load(Ordering::SeqCst), 1);
        assert_eq!(artifact_gets.load(Ordering::SeqCst), 0);

        let data_dir = tmp.path().join("boot_data");
        let dir_s = data_dir.display().to_string();

        let bad_cli = Cli::try_parse_from(["clec", "--data-dir", &dir_s, "search", "   "]).unwrap();
        assert_eq!(
            dispatch(&bad_cli, true, &opts).unwrap_err().code,
            ErrorCode::InvalidQuery
        );
        assert!(!data_dir.exists());
        assert_eq!(manifest_gets.load(Ordering::SeqCst), 1);

        let miss_cli = Cli::try_parse_from([
            "clec",
            "--data-dir",
            &dir_s,
            "read",
            "p_000000000000000000000000",
        ])
        .unwrap();
        assert_eq!(
            dispatch(&miss_cli, true, &opts).unwrap_err().code,
            ErrorCode::EvidenceNotFound
        );
        assert_eq!(manifest_gets.load(Ordering::SeqCst), 2);
        assert_eq!(artifact_gets.load(Ordering::SeqCst), 1);
        assert!(data_dir.join("active.json").is_file());

        let search_cli =
            Cli::try_parse_from(["clec", "--data-dir", &dir_s, "search", "0050"]).unwrap();
        let search_out = dispatch(&search_cli, true, &opts).unwrap();
        let search_val: serde_json::Value = serde_json::from_str(&search_out).unwrap();
        assert_eq!(search_val["data"]["hits"].as_array().unwrap().len(), 1);
        assert_eq!(manifest_gets.load(Ordering::SeqCst), 2);
        assert_eq!(artifact_gets.load(Ordering::SeqCst), 1);

        fs::write(data_dir.join("active.json"), "{corrupt").unwrap();
        assert_eq!(
            dispatch(&search_cli, true, &opts).unwrap_err().code,
            ErrorCode::InvalidPackage
        );
        assert_eq!(manifest_gets.load(Ordering::SeqCst), 2);
        assert_eq!(artifact_gets.load(Ordering::SeqCst), 1);

        let lock_dir = tmp.path().join("lock_boot_data");
        fs::create_dir_all(&lock_dir).unwrap();
        let lf = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_dir.join(".sync.lock"))
            .unwrap();
        lf.lock().unwrap();
        let lock_cli = Cli::try_parse_from([
            "clec",
            "--data-dir",
            &lock_dir.display().to_string(),
            "search",
            "0050",
        ])
        .unwrap();
        assert_eq!(
            dispatch(&lock_cli, true, &opts).unwrap_err().code,
            ErrorCode::SyncLocked
        );
        lf.unlock().unwrap();
        assert_eq!(manifest_gets.load(Ordering::SeqCst), 2);
        assert_eq!(artifact_gets.load(Ordering::SeqCst), 1);

        let _ = reqwest::blocking::get(format!("http://127.0.0.1:{port}/shutdown"));
        let _ = srv.join();
    }

    #[test]
    fn sag2_mode_validation_rejects_conflicts_and_non_search_before_bootstrap() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent_dir = tmp.path().join("never_created_sag2");
        let dir_arg = nonexistent_dir.display().to_string();
        let key_path = tmp.path().join("k.txt");
        std::fs::write(&key_path, "dummy-sentinel\n").unwrap();
        let key_arg = key_path.display().to_string();

        let cases: &[(&[&str], ErrorCode)] = &[
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "--offline",
                    "search",
                    "q",
                    "--sag2",
                ],
                ErrorCode::OfflineRequired,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "q",
                    "--key-file",
                    &key_arg,
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "sync",
                    "--dry-run",
                    "--sag2",
                ],
                ErrorCode::InvalidArgument,
            ),
            (
                &["clec", "--data-dir", &dir_arg, "status", "--sag2"],
                ErrorCode::InvalidArgument,
            ),
            (
                &[
                    "clec",
                    "--data-dir",
                    &dir_arg,
                    "search",
                    "   ",
                    "--sag2",
                    "--key-file",
                    &key_arg,
                ],
                ErrorCode::InvalidQuery,
            ),
        ];

        for (argv, expected_code) in cases {
            let owned: Vec<String> = argv.iter().map(|s| (*s).to_owned()).collect();
            let cli = Cli::try_parse_from(&owned).unwrap();
            let err = dispatch(&cli, true, &RuntimeOptions::shipped()).unwrap_err();
            assert_eq!(err.code, *expected_code, "argv={argv:?}");
        }
        assert!(!nonexistent_dir.exists());
    }

    #[test]
    fn tiny_positive_max_bytes_rejected_before_key_file_store_and_bootstrap() {
        let tmp = tempfile::tempdir().unwrap();
        let cold_dir = tmp.path().join("cold_never_created_budget");
        let dir_arg = cold_dir.display().to_string();
        let missing_key = tmp.path().join("unreadable_missing.key");
        let key_arg = missing_key.display().to_string();

        let sag2_cli = Cli::try_parse_from([
            "clec",
            "--data-dir",
            &dir_arg,
            "--max-bytes",
            "1",
            "search",
            "anchor",
            "--sag2",
            "--key-file",
            &key_arg,
        ])
        .unwrap();
        let err_sag2 = dispatch(&sag2_cli, true, &RuntimeOptions::shipped()).unwrap_err();
        assert_eq!(err_sag2.code, ErrorCode::OutputBudgetTooSmall);
        assert!(err_sag2.sag2_stage.is_none());
        assert!(!cold_dir.exists());
    }

    #[test]
    fn minimum_search_envelope_is_conservative_lower_bound_across_modes() {
        assert_eq!(serde_json::to_string(&0.0_f64).unwrap().len(), 3);
        let prepared = PreparedSearch::prepare(SearchRequest {
            queries: vec!["anchor".to_owned()],
            match_mode: MatchMode::Any,
            limit: DEFAULT_SEARCH_LIMIT,
            offset: 0,
            per_work: DEFAULT_PER_WORK,
            work_filter: None,
            source_filter: None,
            role_filter: None,
            date_from: None,
            date_to: None,
            release_pin: None,
        })
        .unwrap();

        for use_json in [false, true] {
            let min_b =
                minimum_sag2_search_envelope_bytes(&prepared, use_json, DEFAULT_MAX_BYTES).unwrap();
            use crate::sag2::{Sag2Limits, effective_dpp_top_k, jev::JevAdmissionPolicy};

            for policy in [
                JevAdmissionPolicy::CalibratedJev114BodyBounded,
                JevAdmissionPolicy::UncalibratedConservativeByteBound,
            ] {
                for (stop_reason, actual_model) in [
                    (Sag2StopReason::Completed, Some("typesafe/jev-1.14")),
                    (Sag2StopReason::NoCandidates, None),
                    (Sag2StopReason::NoQualifiedSeeds, Some("typesafe/jev-1.14")),
                    (Sag2StopReason::NoExpansionTerms, Some("typesafe/jev-1.14")),
                    (
                        Sag2StopReason::NoExpansionCandidates,
                        Some("typesafe/jev-1.14"),
                    ),
                ] {
                    for has_more in [false, true] {
                        let mut data = minimum_sag2_search_data(&prepared, DEFAULT_MAX_BYTES);
                        data.queries.clear();
                        data.requested_model = "typesafe/jev-1.14".to_owned();
                        data.actual_model = actual_model.map(str::to_owned);
                        data.stop_reason = stop_reason;
                        data.has_more = has_more;
                        data.limits =
                            Sag2Limits::for_policy(policy, effective_dpp_top_k(prepared.limit));
                        data.consumption.token_estimate_basis =
                            policy.token_estimate_basis().to_owned();
                        let output = SearchOutput::Sag2(Box::new(
                            Sag2SearchOutput::project(data, prepared.normalization).unwrap(),
                        ));
                        let rendered_bytes = format_search(&output, use_json).unwrap().len();
                        assert!(
                            min_b <= rendered_bytes,
                            "{policy:?}, {stop_reason:?}, has_more={has_more}, use_json={use_json}, min_b={min_b}, rendered={rendered_bytes}"
                        );
                    }
                }
            }

            let at_min = minimum_sag2_search_envelope_bytes(&prepared, use_json, min_b).unwrap();
            assert!(at_min <= min_b, "use_json={use_json}");

            let tmp = tempfile::tempdir().unwrap();
            let cold = tmp.path().join("cold_bound");
            let mut argv = vec![
                "clec".to_owned(),
                "--data-dir".to_owned(),
                cold.display().to_string(),
                "--max-bytes".to_owned(),
                (at_min - 1).to_string(),
                "search".to_owned(),
                "anchor".to_owned(),
                "--sag2".to_owned(),
                "--key-file".to_owned(),
                tmp.path().join("missing.key").display().to_string(),
            ];
            let cli_under = Cli::try_parse_from(&argv).unwrap();
            let err_under = dispatch(&cli_under, use_json, &RuntimeOptions::shipped()).unwrap_err();
            assert_eq!(err_under.code, ErrorCode::OutputBudgetTooSmall);
            assert!(!cold.exists());

            argv[4] = at_min.to_string();
            let cli_at = Cli::try_parse_from(&argv).unwrap();
            let err_at = dispatch(&cli_at, use_json, &RuntimeOptions::shipped()).unwrap_err();
            assert_ne!(
                err_at.code,
                ErrorCode::OutputBudgetTooSmall,
                "at exact lower bound, pre-I/O admission must allow proceeding"
            );
        }
    }

    #[test]
    fn resolve_data_dir_enforces_precedence_platform_defaults_and_no_cwd_fallback() {
        use std::collections::HashMap;
        use std::ffi::OsString;

        let map_lookup = |pairs: &[(&str, &str)]| {
            let map: HashMap<String, OsString> = pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), OsString::from(v)))
                .collect();
            move |key: &str| map.get(key).cloned()
        };

        let explicit = PathBuf::from("/explicit/dir");
        assert_eq!(
            resolve_data_dir_with_env(
                Some(&explicit),
                map_lookup(&[("CLEC_DATA_DIR", "/env/dir"), ("HOME", "/home/u")]),
            )
            .unwrap(),
            explicit
        );

        let empty_explicit = PathBuf::from("");
        let empty_err = resolve_data_dir_with_env(
            Some(&empty_explicit),
            map_lookup(&[("CLEC_DATA_DIR", "/env/dir"), ("HOME", "/home/u")]),
        )
        .unwrap_err();
        assert_eq!(empty_err.code, ErrorCode::InvalidDataDir);

        assert_eq!(
            resolve_data_dir_with_env(
                None,
                map_lookup(&[("CLEC_DATA_DIR", "/env/dir"), ("HOME", "/home/u")]),
            )
            .unwrap(),
            PathBuf::from("/env/dir")
        );

        let unix_from_empty_env = resolve_unix_data_dir_with(&map_lookup(&[
            ("CLEC_DATA_DIR", "   "),
            ("HOME", "/home/alice"),
        ]))
        .unwrap();
        assert_eq!(
            unix_from_empty_env,
            PathBuf::from("/home/alice/.local/share/clec/native-v2")
        );

        assert_eq!(
            resolve_data_dir_with_env(
                None,
                map_lookup(&[
                    ("CLEC_DATA_DIR", "  "),
                    ("HOME", "/home/alice"),
                    ("LOCALAPPDATA", "C:\\Users\\alice\\AppData\\Local"),
                ]),
            )
            .unwrap(),
            if cfg!(windows) {
                PathBuf::from("C:\\Users\\alice\\AppData\\Local")
                    .join("clec")
                    .join("native-v2")
            } else {
                PathBuf::from("/home/alice/.local/share/clec/native-v2")
            }
        );

        for bad_home in ["", "   "] {
            let err = resolve_unix_data_dir_with(&map_lookup(&[("HOME", bad_home)])).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidDataDir);
        }
        let err_absent = resolve_unix_data_dir_with(&map_lookup(&[])).unwrap_err();
        assert_eq!(err_absent.code, ErrorCode::InvalidDataDir);
        assert!(err_absent.message.contains("--data-dir"));

        assert_eq!(
            resolve_windows_data_dir_with(&map_lookup(&[
                ("LOCALAPPDATA", "/win/local"),
                ("USERPROFILE", "/win/profile"),
            ]))
            .unwrap(),
            PathBuf::from("/win/local").join("clec").join("native-v2")
        );
        assert_eq!(
            resolve_windows_data_dir_with(&map_lookup(&[
                ("LOCALAPPDATA", "  "),
                ("USERPROFILE", "/win/profile"),
            ]))
            .unwrap(),
            PathBuf::from("/win/profile")
                .join("AppData")
                .join("Local")
                .join("clec")
                .join("native-v2")
        );
        let win_absent = resolve_windows_data_dir_with(&map_lookup(&[
            ("LOCALAPPDATA", ""),
            ("USERPROFILE", ""),
        ]))
        .unwrap_err();
        assert_eq!(win_absent.code, ErrorCode::InvalidDataDir);
        assert!(win_absent.message.contains("--data-dir"));
    }
}
