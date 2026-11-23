use std::{
    fs::File,
    io::{self, BufRead, BufReader, Write},
    path::PathBuf,
    time::Instant,
};

use anyhow::{Result, ensure};
use clap::{Parser, Subcommand};
use clec::{
    schema,
    search::{Search, elapsed_ms},
    tokenizer::{StopWords, initialize_for_timing},
};

#[derive(Parser)]
#[command(about = "Stage 0 offline retrieval benchmark runner")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Build {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 4)]
        threads: usize,
        #[arg(long)]
        pack_zst: Option<PathBuf>,
    },
    Search {
        #[arg(long)]
        index: PathBuf,
        #[arg(long, default_value_t = 15)]
        limit: usize,
        #[arg(long)]
        timings: bool,
        query: String,
    },
    Batch {
        #[arg(long)]
        index: PathBuf,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        snippets: bool,
        #[arg(long)]
        timings: bool,
        #[arg(long, value_enum)]
        stopwords: Option<StopWords>,
    },
}

fn main() -> Result<()> {
    let started = Instant::now();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    match Cli::parse().command {
        Command::Build {
            input,
            output,
            threads,
            pack_zst,
        } => {
            ensure!(
                (1..=16).contains(&threads),
                "expected 1 through 16 indexing threads"
            );
            if let Some(archive) = &pack_zst {
                schema::check_pack_output(&output, archive)?;
            }
            let count = schema::build(BufReader::new(File::open(input)?), &output, threads)?;
            if let Some(archive) = pack_zst {
                schema::pack(&output, &archive)?;
            }
            writeln!(stdout, "{{\"passages\":{count},\"segments\":1}}")?;
        }
        Command::Search {
            index,
            limit,
            query,
            timings,
        } => {
            ensure!(limit > 0, "limit must be positive");
            let before_open_ms = elapsed_ms(started);
            let open = Instant::now();
            let search = Search::open(&index)?;
            let index_open_ms = elapsed_ms(open);
            if timings {
                let (jieba_init_ms, zhconv_init_ms) = initialize_for_timing();
                let (hits, query) = search.run(&query, limit, true)?;
                let in_main_ms = elapsed_ms(started);
                serde_json::to_writer(
                    &mut stdout,
                    &serde_json::json!({
                        "hits": hits, "query": query, "before_open_ms": before_open_ms,
                        "index_open_ms": index_open_ms, "jieba_init_ms": jieba_init_ms,
                        "zhconv_init_ms": zhconv_init_ms, "in_main_ms": in_main_ms,
                    }),
                )?;
            } else {
                serde_json::to_writer(&mut stdout, &search.run(&query, limit, true)?.0)?;
            }
            writeln!(stdout)?;
        }
        Command::Batch {
            index,
            limit,
            snippets,
            timings,
            stopwords,
        } => {
            ensure!(limit > 0, "limit must be positive");
            let search = Search::open(&index)?;
            for line in io::stdin().lock().lines() {
                let query: String = serde_json::from_str(&line?)?;
                let (hits, timing) = search.run_with_stopwords(
                    &query,
                    limit,
                    snippets,
                    stopwords.unwrap_or(StopWords::DEFAULT),
                )?;
                if timings {
                    serde_json::to_writer(&mut stdout, &(hits, timing))?;
                } else {
                    serde_json::to_writer(&mut stdout, &hits)?;
                }
                writeln!(stdout)?;
            }
        }
    }
    stdout.flush()?;
    Ok(())
}
