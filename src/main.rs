use std::{
    fs::File,
    io::{self, BufRead, BufReader, IsTerminal, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand, error::ErrorKind};
use clec::{
    builder,
    metadata::Metadata,
    reader::{Reading, Snapshot},
    schema::{Kind, parse_date},
    search::{Options, Search},
    sync::{self, SyncOptions},
    tokenizer::query_terms,
};
use serde::Serialize;
use serde_json::json;

#[derive(Parser)]
#[command(version, about = "Build, query, and sync a local offline passage index", color = clap::ColorChoice::Never, after_help = "\
Examples:
  clec search 'asset allocation' --kind doc,qa --limit 5
  clec search 'retirement' --ids-only | clec read --stdin
  clec read --work episode-12 --range 02:00-05:00

Exit codes:
  0  Success, including no search hits
  2  Invalid arguments, query, or build input
  3  Missing or invalid index
  4  Unknown work or passage ID
  5  Sync, network, or checksum failure

Color is disabled in all modes (including when NO_COLOR is set).")]
struct Cli {
    /// Index snapshot directory (default: ~/.local/share/clec/index)
    #[arg(long, global = true, env = "CLEC_INDEX_DIR", value_name = "DIR")]
    index: Option<PathBuf>,
    /// Print compact JSON, the default when stdout is redirected
    #[arg(long, global = true, conflicts_with = "jsonl")]
    json: bool,
    /// Print newline-delimited JSON (one hit per line for search)
    #[arg(long, global = true)]
    jsonl: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Compile a JSONL corpus into a new index snapshot
    #[command(after_help = "\
Input schema (one UTF-8 JSON object per line):
  Required text: doc_id, work_id, source_id, title, body.
  Required values: ordinal (starts at 0 per source), kind (doc, transcript,
  qa, summary), quality (1 through 4).
  Optional: date (YYYY-MM-DD or null), start_sec and end_sec (nonnegative
  integers or null), heading, origin_url, other_kinds (string array),
  license_mode (full by default, or snippet_only).")]
    Build {
        /// Input JSONL file, one passage per line
        #[arg(long)]
        input: PathBuf,
        /// Optional corpus metadata JSON file
        #[arg(long)]
        meta: Option<PathBuf>,
        /// Optional synonym groups JSON file
        #[arg(long)]
        synonyms: Option<PathBuf>,
        /// New index directory to publish
        #[arg(long)]
        output: PathBuf,
        /// Also write a new .tar.zst archive outside the index
        #[arg(long)]
        pack_zst: Option<PathBuf>,
        /// Number of indexing threads
        #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u8).range(1..=16))]
        threads: u8,
    },
    /// Search one to four free-text queries and fuse their ranked results
    Search(SearchArgs),
    /// List a work's sources and ordered passages
    Outline {
        work_id: String,
        /// Limit to comma-separated passage kinds
        #[arg(long, value_delimiter = ',')]
        kind: Vec<Kind>,
    },
    /// Read passages by ID or by a time range within a work
    Read(ReadArgs),
    /// Download or update the offline index pack
    Sync(SyncArgs),
    /// Show corpus metadata and coverage
    Stats,
}

#[derive(Args)]
struct SearchArgs {
    /// Free text. Quote queries containing spaces
    #[arg(required = true, num_args = 1..=4)]
    queries: Vec<String>,
    /// Limit to comma-separated passage kinds
    #[arg(long, value_delimiter = ',')]
    kind: Vec<Kind>,
    /// Include passages dated on or after YYYY-MM-DD
    #[arg(long, value_parser = date_arg)]
    from: Option<i64>,
    /// Include passages dated on or before YYYY-MM-DD
    #[arg(long, value_parser = date_arg)]
    to: Option<i64>,
    /// Limit results to one work ID
    #[arg(long)]
    work: Option<String>,
    /// Maximum number of hits to return
    #[arg(long, default_value_t = 15, value_parser = clap::value_parser!(u8).range(1..=50))]
    limit: u8,
    /// Skip this many ranked hits
    #[arg(long, default_value_t = 0)]
    offset: usize,
    /// Hits per work before remaining hits are moved to the tail
    #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u8).range(1..=5))]
    per_work: u8,
    /// Omit suspect passages (quality 4)
    #[arg(long)]
    exclude_suspect: bool,
    /// Print one document ID per line
    #[arg(long = "brief", visible_alias = "ids-only", conflicts_with_all = ["json", "jsonl"])]
    ids_only: bool,
}

#[derive(Args)]
#[group(skip)]
#[command(group(clap::ArgGroup::new("target").required(true).args(["doc_ids", "stdin", "work"])))]
struct ReadArgs {
    /// One or more passage IDs
    doc_ids: Vec<String>,
    /// Number of adjacent passages on each side
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u8).range(0..=5))]
    context: u8,
    /// Work ID to read by time range
    #[arg(long, requires = "range")]
    work: Option<String>,
    /// Inclusive overlap in mm:ss-mm:ss or hh:mm:ss-hh:mm:ss
    #[arg(long, requires = "work", value_parser = time_range)]
    range: Option<(u64, u64)>,
    /// Read one passage ID per line from stdin
    #[arg(long)]
    stdin: bool,
}

#[derive(Args)]
struct SyncArgs {
    /// Manifest URL to fetch
    #[arg(
        long,
        env = "CLEC_MANIFEST_URL",
        default_value = sync::DEFAULT_MANIFEST_URL,
        value_name = "URL"
    )]
    manifest_url: String,
    /// Re-download and replace the index even when it is up to date
    #[arg(long)]
    force: bool,
    /// Report whether an update is available without downloading it
    #[arg(long)]
    check: bool,
}

fn date_arg(input: &str) -> Result<i64, String> {
    parse_date(input).map_err(|error| format!("{error:#}"))
}

fn time_range(input: &str) -> Result<(u64, u64), String> {
    fn seconds(input: &str) -> Option<u64> {
        let (first, rest) = input.split_once(':')?;
        if !first.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        if rest.split(':').count() > 2 {
            return None;
        }
        rest.split(':')
            .try_fold(first.parse::<u64>().ok()?, |total, part| {
                let [tens @ b'0'..=b'5', ones @ b'0'..=b'9'] = *part.as_bytes() else {
                    return None;
                };
                total
                    .checked_mul(60)?
                    .checked_add(u64::from((tens - b'0') * 10 + ones - b'0'))
            })
    }
    input
        .split_once('-')
        .and_then(|(start, end)| Some((seconds(start)?, seconds(end)?)))
        .filter(|&(start, end)| start <= end && end < u64::MAX)
        .ok_or_else(|| "expected an ordered mm:ss-mm:ss or hh:mm:ss-hh:mm:ss range".into())
}

struct Failure(u8, anyhow::Error);

impl Failure {
    fn invalid_input(error: anyhow::Error) -> Self {
        Self(2, error)
    }

    fn invalid_index(error: anyhow::Error) -> Self {
        Self(3, error)
    }

    fn missing(kind: &str, id: &str) -> Self {
        Self(4, anyhow::anyhow!("{kind} {id:?} does not exist"))
    }

    fn sync(error: anyhow::Error) -> Self {
        Self(5, error)
    }
}

type CliResult = Result<(), Failure>;

struct Output<W> {
    writer: W,
    human: bool,
    jsonl: bool,
}

impl<W: Write> Output<W> {
    fn json(&mut self, value: &impl Serialize) -> Result<()> {
        serde_json::to_writer(&mut self.writer, value)?;
        Ok(writeln!(self.writer)?)
    }

    fn show(
        &mut self,
        value: &impl Serialize,
        human: impl FnOnce(&mut W) -> Result<()>,
    ) -> Result<()> {
        if self.human {
            human(&mut self.writer)
        } else {
            self.json(value)
        }
    }
}

fn main() -> std::process::ExitCode {
    let stdout = io::stdout();
    let human = stdout.is_terminal();
    let args: Vec<_> = std::env::args_os().collect();
    let explicit_json = args
        .iter()
        .skip(1)
        .take_while(|arg| *arg != "--")
        .any(|arg| arg == "--json" || arg == "--jsonl");
    let fail = |Failure(code, error)| {
        let mut stderr = io::stderr().lock();
        let _ = if human && stderr.is_terminal() && !explicit_json {
            writeln!(stderr, "{error:#}")
        } else {
            writeln!(
                stderr,
                "{}",
                json!({"error": {"code": code, "message": format!("{error:#}")}})
            )
        };
        std::process::ExitCode::from(code)
    };
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            let _ = error.print();
            return std::process::ExitCode::SUCCESS;
        }
        Err(error) => return fail(Failure(2, anyhow::anyhow!("{}", error.to_string().trim()))),
    };
    let mut output = Output {
        writer: io::BufWriter::new(stdout.lock()),
        human: human && !cli.json && !cli.jsonl,
        jsonl: cli.jsonl,
    };
    match execute(cli, &mut output).and_then(|()| {
        output
            .writer
            .flush()
            .map_err(|error| Failure(2, error.into()))
    }) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(Failure(_, error))
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::BrokenPipe) =>
        {
            std::process::ExitCode::SUCCESS
        }
        Err(error) => fail(error),
    }
}

fn execute(cli: Cli, output: &mut Output<impl Write>) -> CliResult {
    let path = cli.index.unwrap_or_else(|| {
        std::env::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(".local/share/clec/index")
    });
    match cli.command {
        Command::Build {
            input,
            meta,
            synonyms,
            output: destination,
            pack_zst,
            threads,
        } => {
            if let Some(archive) = &pack_zst {
                builder::check_pack_output(&destination, archive)
                    .map_err(Failure::invalid_input)?;
            }
            let stream = File::open(&input)
                .with_context(|| format!("opening {}", input.display()))
                .map_err(Failure::invalid_input)?;
            let count = builder::build_with_sidecars(
                BufReader::new(stream),
                &destination,
                threads.into(),
                meta.as_deref(),
                synonyms.as_deref(),
            )
            .map_err(Failure::invalid_input)?;
            if let Some(archive) = &pack_zst {
                builder::pack(&destination, archive).map_err(Failure::invalid_input)?;
            }
            output
                .show(&json!({"passages": count, "segments": 1}), |out| {
                    Ok(writeln!(
                        out,
                        "Built {count} passages in {}",
                        destination.display()
                    )?)
                })
                .map_err(Failure::invalid_input)
        }
        Command::Search(args) => search(&path, args, output),
        Command::Outline { work_id, kind } => {
            let outline = Snapshot::open(&path)
                .and_then(|snapshot| snapshot.outline(&work_id, &kind))
                .map_err(Failure::invalid_index)?
                .ok_or_else(|| Failure::missing("work_id", &work_id))?;
            output
                .show(&outline, |out| {
                    writeln!(
                        out,
                        "{}  ·  {} sources  ·  {} passages",
                        outline.work_id,
                        outline.sources.len(),
                        outline.passages.len()
                    )?;
                    for source in &outline.sources {
                        writeln!(
                            out,
                            "  {}  {}  {} passages",
                            source.source_id, source.kind, source.passages
                        )?;
                        if !source.origin_url.is_empty() {
                            writeln!(out, "    {}", source.origin_url)?;
                        }
                    }
                    if !outline.sources.is_empty() {
                        writeln!(out)?;
                    }
                    for passage in &outline.passages {
                        writeln!(
                            out,
                            "{}  {}  {}",
                            passage.doc_id, passage.kind, passage.heading
                        )?;
                        if let Some(range) = &passage.time_range {
                            writeln!(out, "  {range}")?;
                        }
                        writeln!(out, "  {}", passage.preview)?;
                    }
                    Ok(())
                })
                .map_err(Failure::invalid_input)
        }
        Command::Read(args) => read(&path, args, output),
        Command::Sync(args) => {
            let human = output.human;
            sync::run(
                &SyncOptions {
                    manifest_url: &args.manifest_url,
                    index_dir: &path,
                    force: args.force,
                    check: args.check,
                },
                &mut output.writer,
                human,
            )
            .map_err(Failure::sync)
        }
        Command::Stats => {
            Snapshot::open(&path).map_err(Failure::invalid_index)?;
            let stats = Metadata::load(&path.join("meta.json")).map_err(Failure::invalid_index)?;
            output
                .show(&stats, |out| {
                    writeln!(
                        out,
                        "{} works  ·  {} sources  ·  {} passages",
                        stats.counts.works, stats.counts.sources, stats.counts.passages
                    )?;
                    for (label, rows) in [
                        ("Kind", &stats.counts.by_kind),
                        ("Quality", &stats.counts.by_quality),
                        ("Year", &stats.counts.by_year),
                    ] {
                        writeln!(out, "{label}")?;
                        for (key, count) in rows {
                            writeln!(out, "  {key:<12} {count}")?;
                        }
                    }
                    for gap in &stats.known_gaps {
                        writeln!(out, "• {gap}")?;
                    }
                    if !stats.disclaimer.is_empty() {
                        writeln!(out, "{}", stats.disclaimer)?;
                    }
                    Ok(())
                })
                .map_err(Failure::invalid_input)
        }
    }
}

fn search(path: &Path, args: SearchArgs, output: &mut Output<impl Write>) -> CliResult {
    if matches!(args.from.zip(args.to), Some((from, to)) if from > to) {
        return Err(Failure::invalid_input(anyhow::anyhow!(
            "--from must be on or before --to"
        )));
    }
    if args
        .queries
        .iter()
        .any(|query| query_terms(query).is_empty())
    {
        return Err(Failure::invalid_input(anyhow::anyhow!(
            "each query must contain a searchable term"
        )));
    }
    let search = Search::open(path).map_err(Failure::invalid_index)?;
    if let Some(work_id) = &args.work
        && !search.has_work(work_id).map_err(Failure::invalid_index)?
    {
        return Err(Failure::missing("work_id", work_id));
    }
    let options = Options {
        kinds: &args.kind,
        from: args.from,
        to: args.to,
        work: args.work.as_deref(),
        limit: args.limit.into(),
        offset: args.offset,
        per_work: args.per_work.into(),
        exclude_suspect: args.exclude_suspect,
    };
    let page = search
        .page(&args.queries, &options, !args.ids_only)
        .map_err(Failure::invalid_index)?;
    if args.ids_only || output.jsonl {
        for hit in &page.hits {
            if args.ids_only {
                writeln!(output.writer, "{}", hit.info.doc_id)
                    .map_err(|error| Failure::invalid_input(error.into()))?;
            } else {
                output.json(hit).map_err(Failure::invalid_input)?;
            }
        }
        return Ok(());
    }
    output
        .show(&page, |out| {
            writeln!(out, "{} hits  ·  offset {}", page.total, page.offset)?;
            for hit in &page.hits {
                writeln!(
                    out,
                    "{}  {}  {}",
                    hit.info.doc_id, hit.info.kind, hit.info.title
                )?;
                if !hit.info.origin_url.is_empty() {
                    writeln!(out, "  {}", hit.info.origin_url)?;
                }
                writeln!(out, "  {}", hit.snippet)?;
            }
            Ok(())
        })
        .map_err(Failure::invalid_input)
}

fn read(path: &Path, mut args: ReadArgs, output: &mut Output<impl Write>) -> CliResult {
    if args.stdin {
        let stdin = io::stdin();
        if stdin.is_terminal() {
            return Err(Failure::invalid_input(anyhow::anyhow!(
                "--stdin requires redirected input"
            )));
        }
        for line in stdin.lock().lines() {
            let line = line.map_err(|error| Failure::invalid_input(error.into()))?;
            let id = line.trim();
            if !id.is_empty() {
                args.doc_ids.push(id.to_owned());
            }
        }
    }
    let snapshot = Snapshot::open(path).map_err(Failure::invalid_index)?;
    let context = args.context.into();
    let readings: Vec<Reading> = if let (Some(work), Some((start, end))) = (args.work, args.range) {
        snapshot
            .read_range(&work, start, end, context)
            .map_err(Failure::invalid_index)?
            .ok_or_else(|| Failure::missing("work_id", &work))?
    } else {
        args.doc_ids
            .iter()
            .map(|id| {
                snapshot
                    .read_id(id, context)
                    .map_err(Failure::invalid_index)?
                    .ok_or_else(|| Failure::missing("doc_id", id))
            })
            .collect::<Result<_, _>>()?
    };
    output
        .show(&json!({"passages": readings}), |out| {
            if readings.is_empty() {
                writeln!(out, "No passages")?;
            }
            for reading in &readings {
                for passage in reading
                    .before
                    .iter()
                    .chain([&reading.passage])
                    .chain(&reading.after)
                {
                    writeln!(
                        out,
                        "{}  {}  {}",
                        passage.info.doc_id, passage.info.title, passage.quality_note
                    )?;
                    if let Some(range) = &passage.info.time_range {
                        writeln!(out, "{range}")?;
                    }
                    if !passage.info.origin_url.is_empty() {
                        writeln!(out, "{}", passage.info.origin_url)?;
                    }
                    writeln!(out, "{}\n", passage.body)?;
                }
            }
            Ok(())
        })
        .map_err(Failure::invalid_input)
}
