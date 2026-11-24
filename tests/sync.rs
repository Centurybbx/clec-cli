use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, BufReader, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArchiveMode {
    Normal,
    PrimaryServerError,
    TruncatePrimaryOnce,
}

struct State {
    version: Mutex<String>,
    archive: Vec<u8>,
    sha256: String,
    primary_path: Mutex<String>,
    mirrors: Mutex<Vec<String>>,
    mode: Mutex<ArchiveMode>,
    truncated: AtomicBool,
    archive_requests: AtomicUsize,
    range_requests: AtomicUsize,
}

struct TestServer {
    addr: SocketAddr,
    base_url: String,
    state: Arc<State>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl TestServer {
    fn start(archive: Vec<u8>, sha256: String) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{addr}");
        let state = Arc::new(State {
            version: Mutex::new("2026-11-24".to_owned()),
            archive,
            sha256,
            primary_path: Mutex::new("/archive.tar.zst".to_owned()),
            mirrors: Mutex::new(Vec::new()),
            mode: Mutex::new(ArchiveMode::Normal),
            truncated: AtomicBool::new(false),
            archive_requests: AtomicUsize::new(0),
            range_requests: AtomicUsize::new(0),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let thread_state = Arc::clone(&state);
        let thread_stop = Arc::clone(&stop);
        let thread_base = base_url.clone();
        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let _ = handle_connection(stream, &thread_state, &thread_base);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            addr,
            base_url,
            state,
            stop,
            handle: Some(handle),
        }
    }

    fn manifest_url(&self) -> String {
        format!("{}/manifest.json", self.base_url)
    }

    fn set_version(&self, version: &str) {
        *self.state.version.lock().unwrap() = version.to_owned();
    }

    fn set_mode(&self, mode: ArchiveMode) {
        *self.state.mode.lock().unwrap() = mode;
    }

    fn set_primary_path(&self, path: &str) {
        *self.state.primary_path.lock().unwrap() = path.to_owned();
    }

    fn set_mirrors(&self, mirrors: &[&str]) {
        *self.state.mirrors.lock().unwrap() =
            mirrors.iter().map(|mirror| (*mirror).to_owned()).collect();
    }

    fn archive_requests(&self) -> usize {
        self.state.archive_requests.load(Ordering::SeqCst)
    }

    fn range_requests(&self) -> usize {
        self.state.range_requests.load(Ordering::SeqCst)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl State {
    fn mirror_paths(mirrors: &[String], base: &str) -> Vec<String> {
        mirrors.iter().map(|path| format!("{base}{path}")).collect()
    }

    fn is_mirror(mirrors: &[String], path: &str) -> bool {
        mirrors.iter().any(|mirror| mirror == path)
    }
}

fn handle_connection(stream: TcpStream, state: &State, base: &str) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }

    let primary_path = state.primary_path.lock().unwrap().clone();
    let mirrors = state.mirrors.lock().unwrap().clone();
    let reply = if method != "GET" {
        Reply::status(405)
    } else if path == "/manifest.json" {
        let version = state.version.lock().unwrap().clone();
        let body = json!({
            "schema_version": 2,
            "pack_name": "clec",
            "pack_version": version,
            "built_at": "2026-11-24T00:00:00Z",
            "archive_url": format!("{base}{primary_path}"),
            "mirrors": State::mirror_paths(&mirrors, base),
            "sha256": state.sha256,
            "size_bytes": state.archive.len(),
            "counts": {"passages": 1}
        })
        .to_string()
        .into_bytes();
        Reply::ok("application/json", body)
    } else if path == primary_path || State::is_mirror(&mirrors, &path) {
        let primary = path == primary_path;
        let mode = *state.mode.lock().unwrap();
        let range = headers.get("range").map(String::as_str);
        if range.is_some() {
            state.range_requests.fetch_add(1, Ordering::SeqCst);
        }
        if primary && mode == ArchiveMode::PrimaryServerError {
            Reply::status(500)
        } else if primary && mode == ArchiveMode::TruncatePrimaryOnce {
            if !state.truncated.swap(true, Ordering::SeqCst) {
                state.archive_requests.fetch_add(1, Ordering::SeqCst);
                let body = state.archive.clone();
                Reply {
                    status: 200,
                    headers: vec![(
                        "Content-Type".to_owned(),
                        "application/octet-stream".to_owned(),
                    )],
                    truncate_to: Some(body.len() / 2),
                    body,
                }
            } else if range.is_some() {
                state.archive_requests.fetch_add(1, Ordering::SeqCst);
                archive_reply(&state.archive, range)
            } else {
                // Fail unless the client resumes with a Range request.
                Reply::status(500)
            }
        } else {
            state.archive_requests.fetch_add(1, Ordering::SeqCst);
            archive_reply(&state.archive, range)
        }
    } else {
        Reply::status(404)
    };
    write_reply(stream, reply)
}

fn archive_reply(archive: &[u8], range: Option<&str>) -> Reply {
    let (status, body, content_range) = match range.and_then(parse_range) {
        Some(start) if start < archive.len() => (
            206,
            archive[start..].to_vec(),
            Some(format!(
                "bytes {start}-{}/{}",
                archive.len() - 1,
                archive.len()
            )),
        ),
        Some(_) => return Reply::status(416),
        None => (200, archive.to_vec(), None),
    };
    let mut reply = Reply::ok("application/octet-stream", body);
    reply.status = status;
    if let Some(content_range) = content_range {
        reply
            .headers
            .push(("Content-Range".to_owned(), content_range));
    }
    reply
}

fn parse_range(value: &str) -> Option<usize> {
    value
        .strip_prefix("bytes=")?
        .strip_suffix('-')?
        .parse()
        .ok()
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    truncate_to: Option<usize>,
}

impl Reply {
    fn ok(content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".to_owned(), content_type.to_owned())],
            body,
            truncate_to: None,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
            truncate_to: None,
        }
    }
}

fn write_reply(mut stream: TcpStream, reply: Reply) -> io::Result<()> {
    let reason = match reply.status {
        200 => "OK",
        206 => "Partial Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        _ => "Error",
    };
    write!(stream, "HTTP/1.1 {} {reason}\r\n", reply.status)?;
    write!(stream, "Content-Length: {}\r\n", reply.body.len())?;
    write!(stream, "Connection: close\r\n")?;
    for (name, value) in &reply.headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    match reply.truncate_to {
        Some(length) => {
            stream.write_all(&reply.body[..length.min(reply.body.len())])?;
            stream.flush()?;
            let _ = stream.shutdown(Shutdown::Write);
        }
        None => {
            stream.write_all(&reply.body)?;
            stream.flush()?;
        }
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_corpus(scratch: &Path) -> PathBuf {
    let input = scratch.join("corpus.jsonl");
    let passages = [
        json!({
            "doc_id": "work-1-0", "work_id": "work-1", "source_id": "work-1",
            "ordinal": 0, "kind": "doc", "quality": 1, "title": "复利",
            "body": "复利是世界第八大奇迹 compound interest is powerful.",
            "date": "2024-02-29",
        }),
        json!({
            "doc_id": "work-1-1", "work_id": "work-1", "source_id": "work-1",
            "ordinal": 1, "kind": "doc", "quality": 1, "title": "长期投资",
            "body": "长期投资需要耐心 long term investing needs patience.",
            "date": "2024-03-01",
        }),
    ];
    let mut contents = String::new();
    for passage in passages {
        contents.push_str(&passage.to_string());
        contents.push('\n');
    }
    fs::write(&input, contents).unwrap();
    input
}

fn build_archive(scratch: &Path) -> PathBuf {
    let input = write_corpus(scratch);
    let index = scratch.join("built-index");
    let archive = scratch.join("clec.tar.zst");
    let output = Command::new(env!("CARGO_BIN_EXE_clec"))
        .arg("build")
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&index)
        .arg("--pack-zst")
        .arg(&archive)
        .arg("--threads")
        .arg("1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    archive
}

fn build_index(scratch: &Path, index: &Path) {
    fs::create_dir_all(index.parent().unwrap()).unwrap();
    let input = write_corpus(scratch);
    let output = Command::new(env!("CARGO_BIN_EXE_clec"))
        .arg("build")
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(index)
        .arg("--threads")
        .arg("1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_sync(index: &Path, manifest_url: &str, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_clec"))
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
        .arg("--index")
        .arg(index)
        .arg("sync")
        .arg("--manifest-url")
        .arg(manifest_url)
        .args(extra)
        .output()
        .unwrap()
}

fn cli_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON output ({error}): stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn fingerprint(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn collect(dir: &Path, root: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
        let mut entries = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap())
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, root, files);
            } else {
                files.push((
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    fs::read(path).unwrap(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    collect(dir, dir, &mut files);
    files
}

#[test]
fn initial_sync_installs_archive_and_queries_work() {
    let scratch = tempdir().unwrap();
    let archive = build_archive(scratch.path());
    let bytes = fs::read(&archive).unwrap();
    let server = TestServer::start(bytes.clone(), sha256(&bytes));
    let index = scratch.path().join("installed/index");

    let output = run_sync(&index, &server.manifest_url(), &[]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = cli_json(&output);
    assert_eq!(report["status"], "synced");
    assert_eq!(report["version"], "2026-11-24");
    assert_eq!(report["index_dir"], index.to_str().unwrap());
    assert!(index.join("meta.json").is_file());
    assert!(index.join("index").is_dir());

    let stats = Command::new(env!("CARGO_BIN_EXE_clec"))
        .arg("--index")
        .arg(&index)
        .arg("stats")
        .output()
        .unwrap();
    assert!(
        stats.status.success(),
        "{}",
        String::from_utf8_lossy(&stats.stderr)
    );
    assert_eq!(cli_json(&stats)["counts"]["passages"], 2);

    let search = Command::new(env!("CARGO_BIN_EXE_clec"))
        .arg("--index")
        .arg(&index)
        .arg("search")
        .arg("compound")
        .output()
        .unwrap();
    assert!(
        search.status.success(),
        "{}",
        String::from_utf8_lossy(&search.stderr)
    );
    let page = cli_json(&search);
    assert_eq!(page["hits"][0]["doc_id"], "work-1-0");
}

#[test]
fn repeated_sync_is_up_to_date_and_check_reports_updates() {
    let scratch = tempdir().unwrap();
    let archive = build_archive(scratch.path());
    let bytes = fs::read(&archive).unwrap();
    let server = TestServer::start(bytes.clone(), sha256(&bytes));
    let index = scratch.path().join("installed/index");

    let check = run_sync(&index, &server.manifest_url(), &["--check"]);
    assert!(check.status.success());
    let report = cli_json(&check);
    assert_eq!(report["status"], "not_installed");
    assert!(report["local_version"].is_null());
    assert_eq!(report["remote_version"], "2026-11-24");
    assert_eq!(server.archive_requests(), 0);

    let first = run_sync(&index, &server.manifest_url(), &[]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let downloads = server.archive_requests();

    let second = run_sync(&index, &server.manifest_url(), &[]);
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let report = cli_json(&second);
    assert_eq!(report["status"], "up_to_date");
    assert_eq!(report["version"], "2026-11-24");
    assert_eq!(report["index_dir"], index.to_str().unwrap());
    assert_eq!(server.archive_requests(), downloads);

    let check = run_sync(&index, &server.manifest_url(), &["--check"]);
    assert!(check.status.success());
    let report = cli_json(&check);
    assert_eq!(report["status"], "up_to_date");
    assert_eq!(report["local_version"], "2026-11-24");
    assert_eq!(report["remote_version"], "2026-11-24");
    assert_eq!(server.archive_requests(), downloads);

    server.set_version("2026-11-25");
    let check = run_sync(&index, &server.manifest_url(), &["--check"]);
    assert!(check.status.success());
    let report = cli_json(&check);
    assert_eq!(report["status"], "update_available");
    assert_eq!(report["local_version"], "2026-11-24");
    assert_eq!(report["remote_version"], "2026-11-25");
    assert_eq!(report["sha256"], sha256(&bytes));
    assert_eq!(report["size_bytes"], bytes.len());
    assert_eq!(server.archive_requests(), downloads);

    let before_update = server.archive_requests();
    let updated = run_sync(&index, &server.manifest_url(), &[]);
    assert!(
        updated.status.success(),
        "{}",
        String::from_utf8_lossy(&updated.stderr)
    );
    assert_eq!(cli_json(&updated)["status"], "synced");
    assert!(server.archive_requests() > before_update);

    let check = run_sync(&index, &server.manifest_url(), &["--check"]);
    let report = cli_json(&check);
    assert_eq!(report["status"], "up_to_date");
    assert_eq!(report["local_version"], "2026-11-25");

    let before_force = server.archive_requests();
    let forced = run_sync(&index, &server.manifest_url(), &["--force"]);
    assert!(
        forced.status.success(),
        "{}",
        String::from_utf8_lossy(&forced.stderr)
    );
    assert_eq!(cli_json(&forced)["status"], "synced");
    assert!(server.archive_requests() > before_force);
}

#[test]
fn sync_falls_back_to_a_mirror_after_http_error() {
    let scratch = tempdir().unwrap();
    let archive = build_archive(scratch.path());
    let bytes = fs::read(&archive).unwrap();
    let server = TestServer::start(bytes.clone(), sha256(&bytes));
    server.set_primary_path("/broken.tar.zst");
    server.set_mirrors(&["/archive.tar.zst"]);
    server.set_mode(ArchiveMode::PrimaryServerError);
    let index = scratch.path().join("installed/index");

    let output = run_sync(&index, &server.manifest_url(), &[]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(cli_json(&output)["status"], "synced");
    assert!(index.join("meta.json").is_file());
}

#[test]
fn checksum_mismatch_exits_5_and_preserves_the_existing_index() {
    let scratch = tempdir().unwrap();
    let archive = build_archive(scratch.path());
    let bytes = fs::read(&archive).unwrap();
    let wrong_sha = sha256(b"this is not the archive");
    let server = TestServer::start(bytes, wrong_sha);
    let index = scratch.path().join("installed/index");
    build_index(scratch.path(), &index);
    let before = fingerprint(&index);

    let output = run_sync(&index, &server.manifest_url(), &[]);
    assert_eq!(output.status.code(), Some(5));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], 5);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("checksum mismatch")
    );
    assert_eq!(fingerprint(&index), before);

    let leftovers = fs::read_dir(scratch.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".clec-sync-")
        })
        .count();
    assert_eq!(leftovers, 0);
}

#[test]
fn partial_download_resumes_with_range_requests() {
    let scratch = tempdir().unwrap();
    let archive = build_archive(scratch.path());
    let bytes = fs::read(&archive).unwrap();
    let server = TestServer::start(bytes.clone(), sha256(&bytes));
    server.set_mode(ArchiveMode::TruncatePrimaryOnce);
    let index = scratch.path().join("installed/index");

    let output = run_sync(&index, &server.manifest_url(), &[]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(cli_json(&output)["status"], "synced");
    assert!(server.archive_requests() >= 2);
    assert!(server.range_requests() >= 1);
    assert!(index.join("meta.json").is_file());
    assert!(index.join("index").is_dir());
}
