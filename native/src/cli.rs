use std::env;
use std::io::{IsTerminal, Write};
use std::path::PathBuf;

use clap::error::ErrorKind as ClapErrorKind;
use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};

use crate::domain::{
    CORPUS_FORMAT, ClecError, DEFAULT_MAX_BYTES, DateYmd, ErrorCode, ErrorEnvelope, PassageId,
    ReleaseHash, SCHEMA_VERSION, SEGMENTATION_REVISION, SourceId, SourceRole, TypedRef, WorkId,
};
use crate::retrieval::{
    BudgetReport, DEFAULT_PER_WORK, DEFAULT_SEARCH_LIMIT, MatchMode, SearchData, SearchRequest,
    execute_search,
};
use crate::snapshot::{StatusData, SyncData, data_dir_status, open_current_store, sync_local};
use crate::store::{PassageReadItem, SourceListEntry, SourceOriginalItem, SourceOverviewItem};

#[derive(Debug, Parser)]
#[command(
    name = "clec",
    version,
    about = "Offline CLEC evidence search, exact byte-span reads, and local snapshot sync",
    disable_help_subcommand = false
)]
pub struct Cli {
    /// Corpus data directory (defaults to CLEC_DATA_DIR or ~/.local/share/clec)
    #[arg(long, global = true, value_name = "PATH")]
    pub data_dir: Option<PathBuf>,

    /// Emit JSON on stdout even in an interactive terminal
    #[arg(long, global = true)]
    pub json: bool,

    /// Enforce offline execution (always offline in Phase 1)
    #[arg(long, global = true)]
    pub offline: bool,

    /// Maximum UTF-8 byte budget for serialized stdout output
    #[arg(long, global = true, default_value_t = DEFAULT_MAX_BYTES, value_name = "N")]
    pub max_bytes: usize,

    /// Unsupported Phase 1 flag (explicitly rejected)
    #[arg(long, global = true, hide = true)]
    pub sag2: bool,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum MatchArg {
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
pub enum RoleArg {
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
pub enum Commands {
    /// Verify and atomically activate a local release manifest
    Sync(SyncArgs),
    /// Search passages using 1 to 4 queries with BM25 + RRF and work-aware diversity
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
pub struct SyncArgs {
    /// Path to publisher manifest.json
    #[arg(long, value_name = "FILE")]
    pub manifest: Option<String>,
}

#[derive(Debug, Args)]
pub struct SearchArgs {
    /// 1 to 4 lexical queries
    #[arg(required = true, num_args = 1..=4, value_name = "QUERY")]
    pub queries: Vec<String>,

    /// Token matching mode within each query
    #[arg(long, value_enum, default_value_t = MatchArg::Any)]
    pub match_mode: MatchArg,

    /// Maximum returned whole passages (1..=5)
    #[arg(long, default_value_t = DEFAULT_SEARCH_LIMIT, value_name = "N")]
    pub limit: usize,

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
}

#[derive(Debug, Args)]
pub struct ReadArgs {
    /// Typed PassageId (p_...) or SourceId (s_...) references
    #[arg(required = true, num_args = 1..=50, value_name = "ID")]
    pub ids: Vec<String>,

    /// Adjacent passages per side for PassageId reads (0..=2)
    #[arg(long, default_value_t = 1, value_name = "N")]
    pub context: usize,

    /// Return verbatim original UTF-8 text for a SourceId (s_...)
    #[arg(long)]
    pub original: bool,

    /// Literal unnormalized substring search inside the read target
    #[arg(long, value_name = "LITERAL")]
    pub find: Option<String>,
}

#[derive(Debug, Args)]
pub struct SourcesArgs {
    /// Optional normalized filter terms across work/source title and path
    #[arg(value_name = "QUERY")]
    pub query: Option<String>,

    /// Filter by WorkId (w_...)
    #[arg(long, value_name = "WORK_ID")]
    pub work: Option<String>,

    /// Filter by source role
    #[arg(long, value_enum)]
    pub role: Option<RoleArg>,

    /// Maximum sources returned (1..=100)
    #[arg(long, default_value_t = 50, value_name = "N")]
    pub limit: usize,

    /// Zero-based pagination offset
    #[arg(long, default_value_t = 0, value_name = "N")]
    pub offset: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SuccessEnvelope<T> {
    pub schema_version: u32,
    pub ok: bool,
    pub command: String,
    pub data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum ReadItem {
    Passage(Box<PassageReadItem>),
    SourceOriginal(SourceOriginalItem),
    SourceOverview(SourceOverviewItem),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadData {
    pub release: ReleaseHash,
    pub items: Vec<ReadItem>,
    pub budget: ReadBudgetReport,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadBudgetReport {
    pub max_bytes: usize,
    pub used_bytes: usize,
    pub omitted_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourcesData {
    pub release: ReleaseHash,
    pub total_matched: usize,
    pub offset: usize,
    pub limit: usize,
    pub items: Vec<SourceListEntry>,
    pub budget: ReadBudgetReport,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemaArgSpec {
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
pub struct SchemaCommandSpec {
    pub name: String,
    pub about: Option<String>,
    pub supported: bool,
    pub options: Vec<SchemaArgSpec>,
    pub positionals: Vec<SchemaArgSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedFeatureSpec {
    pub name: String,
    pub supported: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemaData {
    pub phase: String,
    pub binary: String,
    pub version: String,
    pub corpus_format: String,
    pub segmentation_revision: String,
    pub global_options: Vec<SchemaArgSpec>,
    pub commands: Vec<SchemaCommandSpec>,
    pub unsupported_features: Vec<UnsupportedFeatureSpec>,
    pub envelopes: serde_json::Value,
}

pub fn run_cli() -> i32 {
    let args: Vec<String> = env::args().collect();
    run_cli_with_args(&args)
}

pub fn run_cli_with_args(args: &[String]) -> i32 {
    let parsed = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(err) => match err.kind() {
            ClapErrorKind::DisplayHelp | ClapErrorKind::DisplayVersion => {
                let _ = write_stdout_safe(&err.to_string());
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
    if parsed.sag2 {
        let err = ClecError::new(
            ErrorCode::UnsupportedFeature,
            "--sag2 is unsupported in Phase 1; no external API calls are permitted.",
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
    match dispatch(&parsed, use_json) {
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

fn resolve_data_dir(explicit: Option<&PathBuf>) -> PathBuf {
    if let Some(p) = explicit {
        return p.clone();
    }
    if let Ok(env_dir) = env::var("CLEC_DATA_DIR")
        && !env_dir.trim().is_empty()
    {
        return PathBuf::from(env_dir);
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".local").join("share").join("clec")
}

fn dispatch(cli: &Cli, use_json: bool) -> Result<String, ClecError> {
    let data_dir = resolve_data_dir(cli.data_dir.as_ref());
    let max_bytes = cli.max_bytes;

    match &cli.command {
        Commands::Schema => {
            let data = build_schema_data();
            serialize_fixed("schema", &data, use_json, max_bytes, format_schema_text)
        }
        Commands::Status => {
            let data = data_dir_status(&data_dir)?;
            serialize_fixed("status", &data, use_json, max_bytes, format_status_text)
        }
        Commands::Sync(args) => {
            let data = sync_local(&data_dir, args.manifest.as_deref())?;
            serialize_fixed("sync", &data, use_json, max_bytes, format_sync_text)
        }
        Commands::Search(args) => {
            let store = open_current_store(&data_dir, None)?;
            let req = SearchRequest {
                queries: args.queries.clone(),
                match_mode: args.match_mode.into(),
                limit: args.limit,
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
            let full = execute_search(&store, &req)?;
            fit_search_budget(full, use_json, max_bytes)
        }
        Commands::Sources(args) => {
            if args.limit == 0 || args.limit > 100 {
                return Err(ClecError::new(
                    ErrorCode::InvalidArgument,
                    "--limit for sources must be 1..=100.",
                ));
            }
            let store = open_current_store(&data_dir, None)?;
            let work_filter = args.work.as_deref().map(WorkId::parse).transpose()?;
            let role_filter = args.role.map(Into::into);
            let matched =
                store.list_sources(args.query.as_deref(), work_filter.as_ref(), role_filter)?;
            let total_matched = matched.len();
            let paged: Vec<SourceListEntry> = matched
                .into_iter()
                .skip(args.offset)
                .take(args.limit)
                .collect();
            let data = SourcesData {
                release: store.release,
                total_matched,
                offset: args.offset,
                limit: args.limit,
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
            if args.context > 2 {
                return Err(ClecError::new(
                    ErrorCode::InvalidArgument,
                    "--context must be 0..=2.",
                ));
            }
            let store = open_current_store(&data_dir, None)?;
            let mut items = Vec::with_capacity(args.ids.len());
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
                        let item = store
                            .read_passage(&pid, args.context, args.find.as_deref())
                            .map_err(|e| e.with_input_index(idx))?;
                        items.push(ReadItem::Passage(Box::new(item)));
                    }
                    TypedRef::Source(sid) => {
                        if args.original {
                            let item = store
                                .read_source_original(&sid, args.find.as_deref())
                                .map_err(|e| e.with_input_index(idx))?;
                            items.push(ReadItem::SourceOriginal(item));
                        } else {
                            if args.find.is_some() {
                                return Err(ClecError::new(
                                    ErrorCode::InvalidArgument,
                                    "--find on a SourceId requires --original.",
                                )
                                .with_input_index(idx));
                            }
                            let item = store
                                .read_source_overview(&sid)
                                .map_err(|e| e.with_input_index(idx))?;
                            items.push(ReadItem::SourceOverview(item));
                        }
                    }
                }
            }
            let data = ReadData {
                release: store.release,
                items,
                budget: ReadBudgetReport {
                    max_bytes,
                    used_bytes: 0,
                    omitted_count: 0,
                },
            };
            fit_read_budget(data, use_json, max_bytes)
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
        let mut used_bytes = 0usize;
        for _ in 0..2 {
            let rendered = render_with_keep(keep, used_bytes)?;
            used_bytes = rendered.len();
        }
        let final_out = render_with_keep(keep, used_bytes)?;
        if final_out.len() <= max_bytes {
            return Ok(final_out);
        }
    }
    Err(ClecError::new(
        ErrorCode::OutputBudgetTooSmall,
        format!("Output requires more than --max-bytes {max_bytes} UTF-8 bytes."),
    ))
}

fn fit_search_budget(
    mut data: SearchData,
    use_json: bool,
    max_bytes: usize,
) -> Result<String, ClecError> {
    let all_hits = std::mem::take(&mut data.hits);
    let total = all_hits.len();
    let min_keep = usize::from(total > 0);
    fit_list_budget(total, min_keep, max_bytes, |keep, used_bytes| {
        let omitted_ids: Vec<PassageId> = all_hits[keep..]
            .iter()
            .map(|h| h.passage_id.clone())
            .collect();
        data.hits = all_hits[..keep].to_vec();
        data.budget = BudgetReport {
            max_bytes,
            used_bytes,
            omitted_count: total - keep,
            omitted_ids,
        };
        if use_json {
            serialize_envelope("search", &data)
        } else {
            Ok(format_search_text(&data))
        }
    })
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

fn fit_read_budget(
    mut data: ReadData,
    use_json: bool,
    max_bytes: usize,
) -> Result<String, ClecError> {
    let all_items = std::mem::take(&mut data.items);
    let total = all_items.len();
    fit_list_budget(total, 1, max_bytes, |keep, used_bytes| {
        data.items = all_items[..keep].to_vec();
        data.budget = ReadBudgetReport {
            max_bytes,
            used_bytes,
            omitted_count: total - keep,
        };
        if use_json {
            serialize_envelope("read", &data)
        } else {
            Ok(format_read_text(&data))
        }
    })
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

pub fn build_schema_data() -> SchemaData {
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
        "status": schema_for!(SuccessEnvelope<StatusData>),
        "search": schema_for!(SuccessEnvelope<SearchData>),
        "read": schema_for!(SuccessEnvelope<ReadData>),
        "sources": schema_for!(SuccessEnvelope<SourcesData>),
        "error": schema_for!(ErrorEnvelope),
    });

    SchemaData {
        phase: "phase1".to_owned(),
        binary: cmd.get_name().to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        corpus_format: CORPUS_FORMAT.to_owned(),
        segmentation_revision: SEGMENTATION_REVISION.to_owned(),
        global_options,
        commands,
        unsupported_features: vec![
            UnsupportedFeatureSpec {
                name: "sag2".to_owned(),
                supported: false,
                reason: "LLM/SAG2 retrieval is unsupported in Phase 1; no external API calls are made.".to_owned(),
            },
            UnsupportedFeatureSpec {
                name: "http_bootstrap".to_owned(),
                supported: false,
                reason: "Remote HTTP manifest/artifact bootstrap is deferred to a later phase; use local `sync --manifest FILE`.".to_owned(),
            },
            UnsupportedFeatureSpec {
                name: "cross_format_dedup".to_owned(),
                supported: false,
                reason: "Phase 1 performs conservative exact-content blob sharing only.".to_owned(),
            },
        ],
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
        supported: id != "sag2",
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
            "Counts: works={}, sources={}, blobs={}, passages={}, cues={}, inventory={}",
            c.works, c.sources, c.blobs, c.passages, c.cues, c.inventory
        ));
    }
    lines.join("\n") + "\n"
}

fn format_sync_text(d: &SyncData) -> String {
    format!(
        "Release: {}\nFormat: {}\nReused: {}\nWorks: {}, Sources: {}, Passages: {}\n",
        d.release, d.corpus_format, d.reused, d.counts.works, d.counts.sources, d.counts.passages
    )
}

fn format_search_text(d: &SearchData) -> String {
    let mut out = format!(
        "Release: {}\nCandidates: {}; Returned: {}; Omitted by budget: {}\n\n",
        d.release,
        d.total_candidates,
        d.hits.len(),
        d.budget.omitted_count
    );
    for hit in &d.hits {
        out.push_str(&format!(
            "[{}] {} ({}) score={:.6}\n{}\n\n",
            hit.passage_id, hit.source.title, hit.source.source_id, hit.rrf_score, hit.text
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

fn format_read_text(d: &ReadData) -> String {
    let mut out = format!("Release: {}\n\n", d.release);
    for item in &d.items {
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
        let schema = build_schema_data();
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
        assert!(!sag2.supported);
    }

    #[test]
    fn clap_disables_fuzzy_suggestions_on_unknown_command() {
        let err = Cli::try_parse_from(["clec", "serch"]).unwrap_err();
        let msg = err.to_string();
        assert!(!msg.contains("similar"));
        assert!(!msg.contains("Did you mean"));
    }
}
