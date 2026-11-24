use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

use clec::builder;
use serde_json::{Value, json};
use tempfile::tempdir;

fn cli(index: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_clec"));
    command.arg("--index").arg(index);
    command
}

fn build_fixture(index: &Path) {
    let input = json!({
        "doc_id": "one", "work_id": "work", "source_id": "source", "ordinal": 0,
        "kind": "transcript", "quality": 2, "title": "Fixture", "body": "Transcript",
        "start_sec": 20, "end_sec": 400, "other_kinds": ["qa"],
        "origin_url": "https://example.com/fixture",
    });
    builder::build(input.to_string().as_bytes(), index, 1).unwrap();
}

#[test]
fn stats_requires_a_tantivy_manifest_even_with_valid_corpus_metadata() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("snapshot");
    build_fixture(&index);
    let run_stats = || cli(&index).arg("stats").output().unwrap();
    let valid = run_stats();
    assert!(valid.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&valid.stdout).unwrap()["counts"]["passages"],
        1
    );

    let manifest = index.join("index/meta.json");
    let tantivy_meta = fs::read(&manifest).unwrap();
    fs::remove_file(&manifest).unwrap();
    assert_eq!(run_stats().status.code(), Some(3));
    let nested = index.join("index");
    for entry in fs::read_dir(&nested).unwrap() {
        let entry = entry.unwrap();
        fs::rename(entry.path(), index.join(entry.file_name())).unwrap();
    }
    fs::remove_dir(nested).unwrap();
    assert_eq!(run_stats().status.code(), Some(3));

    // A flat snapshot can carry corpus metadata in the same JSON object as the manifest.
    let corpus_path = index.join("meta.json");
    let mut flat: Value = serde_json::from_slice(&tantivy_meta).unwrap();
    let corpus: Value = serde_json::from_slice(&fs::read(&corpus_path).unwrap()).unwrap();
    flat.as_object_mut()
        .unwrap()
        .extend(corpus.as_object().unwrap().clone());
    fs::write(&corpus_path, flat.to_string()).unwrap();
    assert!(run_stats().status.success());
}

#[test]
fn read_accepts_short_time_ranges_and_trimmed_stdin_ids() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("snapshot");
    build_fixture(&index);
    let read_range = |range| {
        cli(&index)
            .args(["read", "--work", "work", "--range", range])
            .output()
            .unwrap()
    };
    for range in ["0:10-0:30", "5:00-10:00", "0:00:10-0:00:30"] {
        let output = read_range(range);
        assert!(output.status.success(), "{range}: {:?}", output.stderr);
        let body: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(body["passages"][0]["passage"]["doc_id"], "one");
    }
    for range in [
        "0:1-0:30",
        "0:0:10-0:00:30",
        "0:00:1-0:00:30",
        ":10-0:30",
        "+0:10-0:30",
    ] {
        assert_eq!(read_range(range).status.code(), Some(2), "{range}");
    }
    let mut child = cli(&index)
        .args(["read", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(" \t\n  one\t\n\u{3000}\n".as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let body: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(body["passages"].as_array().unwrap().len(), 1);
    assert_eq!(body["passages"][0]["passage"]["doc_id"], "one");
    assert_eq!(body["passages"][0]["passage"]["other_kinds"], json!(["qa"]));
}

#[test]
fn search_outline_and_read_expose_origin_url() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("snapshot");
    build_fixture(&index);
    let url = "https://example.com/fixture";
    let run = |args: &[&str]| {
        let output = cli(&index).args(args).output().unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let search = run(&["search", "Transcript"]);
    assert_eq!(search["hits"][0]["origin_url"], url);
    let outline = run(&["outline", "work"]);
    assert_eq!(outline["sources"][0]["origin_url"], url);
    let read = run(&["read", "one", "--context", "0"]);
    assert_eq!(read["passages"][0]["passage"]["origin_url"], url);
}
