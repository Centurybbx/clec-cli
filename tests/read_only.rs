#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::set_permissions(self.0.join("index"), fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(
            self.0.join("index/index"),
            fs::Permissions::from_mode(0o700),
        );
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn snapshot(index: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = fs::read_dir(index)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect();
    files.sort_unstable();
    files
}

#[test]
fn eight_queries_can_read_an_immutable_snapshot_without_creating_locks() {
    let scratch =
        Scratch(std::env::temp_dir().join(format!("retrieval-read-only-{}", std::process::id())));
    fs::create_dir(&scratch.0).unwrap();
    let input = scratch.0.join("input.jsonl");
    let index = scratch.0.join("index");
    fs::write(&input, concat!(
        r#"{"doc_id":"t","work_id":"t","source_id":"t","ordinal":0,"kind":"doc","quality":1,"title":"例子","body":"繁體"}"#,
        "\n",
        r#"{"doc_id":"s","work_id":"s","source_id":"s","ordinal":0,"kind":"doc","quality":1,"title":"例子","body":"繁体"}"#,
        "\n",
        r#"{"doc_id":"p","work_id":"p","source_id":"p","ordinal":0,"kind":"doc","quality":1,"title":"例子","body":"繁。體"}"#,
        "\n",
    )).unwrap();
    let binary = env!("CARGO_BIN_EXE_clec");
    assert!(
        Command::new(binary)
            .arg("build")
            .arg("--input")
            .arg(&input)
            .arg("--output")
            .arg(&index)
            .arg("--threads")
            .arg("2")
            .output()
            .unwrap()
            .status
            .success()
    );
    fs::remove_file(index.join("index/.tantivy-meta.lock")).unwrap();
    fs::set_permissions(&index, fs::Permissions::from_mode(0o555)).unwrap();
    let files = index.join("index");
    fs::set_permissions(&files, fs::Permissions::from_mode(0o555)).unwrap();
    let before = snapshot(&files);
    let processes: Vec<_> = (0..8)
        .map(|i| {
            Command::new(binary)
                .arg("search")
                .arg("--index")
                .arg(&index)
                .arg(if i % 2 == 0 { "繁體" } else { "繁体" })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in processes {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let page: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let hits = page["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        for hit in hits {
            let expected = match hit["doc_id"].as_str().unwrap() {
                "s" => "繁体",
                "t" => "繁體",
                unexpected => panic!("unexpected result {unexpected}"),
            };
            assert_eq!(hit["highlights"], serde_json::json!([expected]));
        }
    }
    assert_eq!(snapshot(&files), before);
}
