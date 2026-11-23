use std::fs;

use clec::{schema, search::Search};
use serde_json::json;
use tempfile::tempdir;

fn passage(id: &str, body: &str, date: &str) -> String {
    json!({
        "doc_id": id, "work_id": id, "source_id": id, "ordinal": 0,
        "kind": "doc", "quality": 1, "title": "标题", "body": body, "date": date,
    })
    .to_string()
}

#[test]
fn build_rejects_invalid_calendar_dates_and_cleans_up() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("index");
    let valid = passage("valid", "正文", "2024-02-29");
    for date in [
        "2023-02-29",
        "2024-04-31",
        "2024-13-01",
        "2024-01-00",
        "2024-1-01",
        "20240101",
    ] {
        let input = format!("{valid}\n{}", passage("invalid", "正文", date));
        let err = schema::build(input.as_bytes(), &index, 1).unwrap_err();
        assert!(err.to_string().contains("date at line 2"));
        assert_eq!(fs::read_dir(scratch.path()).unwrap().count(), 0);
    }
    let input = format!("{valid}\n{}", passage("empty", "正文", ""));
    assert_eq!(schema::build(input.as_bytes(), &index, 1).unwrap(), 2);
    assert!(schema::build(input.as_bytes(), &index, 1).is_err());
}

#[test]
fn pack_refuses_outputs_inside_the_index_and_existing_files() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("index");
    schema::build(passage("one", "正文", "").as_bytes(), &index, 1).unwrap();
    let nested = index.join("archive.tar.zst");
    assert!(schema::pack(&index, &nested).is_err());
    assert!(!nested.exists());

    #[cfg(unix)]
    {
        let alias = scratch.path().join("alias");
        std::os::unix::fs::symlink(&index, &alias).unwrap();
        assert!(schema::pack(&index, &alias.join("archive.tar.zst")).is_err());
        assert!(!nested.exists());
    }

    let source = scratch.path().join("source.jsonl");
    fs::write(&source, "source contents").unwrap();
    assert!(schema::pack(&index, &source).is_err());
    assert_eq!(fs::read_to_string(source).unwrap(), "source contents");
    let archive = scratch.path().join("archive.tar.zst");
    schema::pack(&index, &archive).unwrap();
    assert!(fs::metadata(archive).unwrap().len() > 0);
}

#[test]
fn all_or_admits_partial_matches_and_repeated_terms_weight_bm25() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("index");
    let input = format!(
        "{}\n{}",
        passage("a", "alpha", ""),
        passage("b", "bravo", ""),
    );
    schema::build(input.as_bytes(), &index, 1).unwrap();
    let search = Search::open(&index).unwrap();
    for (query, expected) in [("alpha alpha bravo", "a"), ("alpha bravo bravo", "b")] {
        let (hits, _) = search.run(query, 2, false).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(serde_json::to_value(&hits[0]).unwrap()["doc_id"], expected);
    }
}
