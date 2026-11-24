use std::fs;

use clec::{
    builder, schema,
    search::{Options, Search},
};
use serde_json::json;
use tempfile::tempdir;

fn passage(id: &str, body: &str, date: Option<&str>) -> String {
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
    let valid = passage("valid", "正文", Some("2024-02-29"));
    for date in [
        "2023-02-29",
        "2024-04-31",
        "2024-13-01",
        "2024-01-00",
        "2024-1-01",
        "20240101",
        "",
    ] {
        let input = format!("{valid}\n{}", passage("invalid", "正文", Some(date)));
        let err = schema::build(input.as_bytes(), &index, 1).unwrap_err();
        assert!(err.to_string().contains("date at line 2"));
        assert_eq!(fs::read_dir(scratch.path()).unwrap().count(), 0);
    }
    let input = format!("{valid}\n{}", passage("empty", "正文", None));
    assert_eq!(schema::build(input.as_bytes(), &index, 1).unwrap(), 2);
    assert!(schema::build(input.as_bytes(), &index, 1).is_err());
}

#[test]
fn pack_refuses_outputs_inside_the_index_and_existing_files() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("index");
    let nested = index.join("archive.tar.zst");
    for output in [&nested, &index.join("new/../archive.tar.zst")] {
        let error = builder::check_pack_output(&index, output).unwrap_err();
        assert_eq!(
            error.to_string(),
            "archive output must be outside the index"
        );
    }
    schema::build(passage("one", "正文", None).as_bytes(), &index, 1).unwrap();
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
        passage("a", "alpha", None),
        passage("b", "bravo", None),
    );
    schema::build(input.as_bytes(), &index, 1).unwrap();
    let search = Search::open(&index).unwrap();
    let options = Options {
        kinds: &[],
        from: None,
        to: None,
        work: None,
        limit: 2,
        offset: 0,
        per_work: 2,
        exclude_suspect: false,
    };
    for (query, expected) in [("alpha alpha bravo", "a"), ("alpha bravo bravo", "b")] {
        let hits = search.page(&[query.into()], &options, false).unwrap().hits;
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].info.doc_id, expected);
    }
}

#[test]
fn builder_rejects_malformed_passages_with_line_numbers() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("index");
    let first = passage("first", "正文", None);
    let second: serde_json::Value = serde_json::from_str(&passage("second", "正文", None)).unwrap();
    for (field, value, expected) in [
        ("doc_id", json!("first"), "duplicate doc_id"),
        ("doc_id", json!(" "), "required text is empty"),
        ("title", json!(""), "required text is empty"),
        ("ordinal", json!(2), "expected ordinal 0"),
        ("kind", json!("other"), "unknown variant"),
        ("other_kinds", json!(["qa", "other"]), "unknown variant"),
        ("other_kinds", json!(["qa", "doc"]), "own kind"),
        ("quality", json!(5), "quality outside"),
        ("license_mode", json!("other"), "unknown variant"),
        ("start_sec", json!(5), "invalid timestamp bounds"),
    ] {
        let mut invalid = second.clone();
        invalid["end_sec"] = json!(4);
        invalid[field] = value;
        let input = format!("{first}\n{invalid}");
        let error = schema::build(input.as_bytes(), &index, 1).unwrap_err();
        let details = format!("{error:#}");
        assert!(
            details.contains("line 2") && details.contains(expected),
            "{details}"
        );
        assert_eq!(fs::read_dir(scratch.path()).unwrap().count(), 0);
    }
}

#[test]
fn supplied_metadata_must_match_built_counts() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("index");
    let meta = scratch.path().join("meta.json");
    let input = passage("one", "正文", Some("2024-02-29"));
    let mut metadata = json!({
        "schema_version": 2,
        "counts": {
            "works": 1, "sources": 1, "passages": 1,
            "by_kind": {"doc": 1}, "by_quality": {"1": 1}, "by_year": {"2023": 1}
        },
        "known_gaps": [],
        "disclaimer": "Fixture"
    });
    fs::write(&meta, metadata.to_string()).unwrap();
    let error =
        builder::build_with_sidecars(input.as_bytes(), &index, 1, Some(&meta), None).unwrap_err();
    assert!(error.to_string().contains("metadata counts do not match"));
    assert_eq!(fs::read_dir(scratch.path()).unwrap().count(), 1);

    metadata["counts"]["by_year"] = json!({"2024": 1});
    fs::write(&meta, metadata.to_string()).unwrap();
    builder::build_with_sidecars(input.as_bytes(), &index, 1, Some(&meta), None).unwrap();
    let built: serde_json::Value =
        serde_json::from_slice(&fs::read(index.join("meta.json")).unwrap()).unwrap();
    assert_eq!(built, metadata);
}

#[test]
fn read_respects_restricted_licenses_for_targets_and_neighbors() {
    let scratch = tempdir().unwrap();
    let index = scratch.path().join("index");
    let long = "正文。".repeat(100);
    let input = [
        json!({
            "doc_id": "one", "work_id": "work", "source_id": "source", "ordinal": 0,
            "kind": "doc", "quality": 1, "title": "标题", "body": long, "license_mode": "snippet_only",
        }),
        json!({
            "doc_id": "two", "work_id": "work", "source_id": "source", "ordinal": 1,
            "kind": "doc", "quality": 1, "title": "标题", "body": long,
        }),
    ];
    let input = format!("{}\n{}", input[0], input[1]);
    schema::build(input.as_bytes(), &index, 1).unwrap();
    let snapshot = clec::reader::Snapshot::open(&index).unwrap();
    let reading = snapshot.read_id("two", 1).unwrap().unwrap();
    assert_eq!(reading.passage.license_mode, "full");
    assert_eq!(reading.passage.body, long);
    assert_eq!(reading.before.len(), 1);
    assert_eq!(reading.before[0].license_mode, "snippet_only");
    assert!(reading.before[0].body.len() <= 550);
    assert!(long.starts_with(&reading.before[0].body));
    let reading = snapshot.read_id("one", 0).unwrap().unwrap();
    assert!(reading.passage.body.len() <= 550);
    assert!(reading.before.is_empty() && reading.after.is_empty());
}
