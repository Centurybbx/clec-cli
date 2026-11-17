#!/usr/bin/env python3
"""Real-binary Phase 4 verification matrix for CLEC native static distribution and bootstrap."""

from __future__ import annotations

import argparse
from compression import zstd as py_zstd
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

if sys.version_info < (3, 14):
    raise SystemExit("verify_phase4.py requires Python >= 3.14 (uses stdlib compression.zstd)")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_cli(
    binary: Path,
    args: list[str],
    env: dict[str, str],
    timeout: float = 45.0,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(binary), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )


def assert_ok_json(proc: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert proc.returncode == 0, f"expected rc=0, got {proc.returncode}: stderr={proc.stderr!r}"
    assert proc.stderr == "", f"expected empty stderr on success, got {proc.stderr!r}"
    obj = json.loads(proc.stdout)
    assert obj.get("schemaVersion") == 1 and obj.get("ok") is True, obj
    return obj["data"]


def assert_err_json(
    proc: subprocess.CompletedProcess[str],
    expected_code: str | None = None,
    expected_exit: int | None = None,
) -> dict[str, Any]:
    assert proc.returncode != 0, f"expected nonzero exit, got 0: stdout={proc.stdout!r}"
    assert proc.stdout == "", f"expected empty stdout on error, got {proc.stdout!r}"
    if expected_exit is not None:
        assert proc.returncode == expected_exit, f"expected exit {expected_exit}, got {proc.returncode}: {proc.stderr!r}"
    obj = json.loads(proc.stderr)
    assert obj.get("schemaVersion") == 1 and obj.get("ok") is False, obj
    err = obj["error"]
    for key in ("code", "message", "remedy", "next"):
        assert err.get(key), f"missing error.{key}: {obj}"
    if expected_code is not None:
        assert err["code"] == expected_code, f"expected {expected_code}, got {err}"
    return err


def snapshot_active_state(data_dir: Path) -> tuple[bytes, str, str]:
    active_bytes = (data_dir / "active.json").read_bytes()
    active_obj = json.loads(active_bytes.decode("utf-8"))
    release = active_obj["release"]
    db_sha = sha256_file(data_dir / f"{release}.sqlite")
    return active_bytes, release, db_sha


def assert_no_partial_artifacts(data_dir: Path) -> None:
    leftovers = [
        p.name
        for p in data_dir.iterdir()
        if p.name in (".incoming.zst.tmp", ".incoming.sqlite.tmp", ".active.tmp")
        or p.name.startswith(".clec-fts-")
    ]
    assert not leftovers, f"unexpected staging files remain: {leftovers}"


def assert_a_preserved(
    clec_bin: Path,
    data_dir: Path,
    clean_env: dict[str, str],
    expected_active_bytes: bytes,
    expected_release: str,
    expected_db_sha: str,
    check_partials: bool = True,
) -> None:
    active_bytes, release, db_sha = snapshot_active_state(data_dir)
    assert active_bytes == expected_active_bytes, "active.json mutated on failed update"
    assert release == expected_release, "active release mutated on failed update"
    assert db_sha == expected_db_sha, "active DB digest mutated on failed update"
    if check_partials:
        assert_no_partial_artifacts(data_dir)
    res = assert_ok_json(
        run_cli(clec_bin, ["--data-dir", str(data_dir), "--offline", "search", "alpha"], clean_env)
    )
    assert res["release"] == expected_release and len(res["hits"]) >= 1


class FixtureServer:
    def __init__(self, ssl_context: ssl.SSLContext | None = None, host: str = "127.0.0.1") -> None:
        self.routes: dict[str, Any] = {}
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        parent = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_GET(self) -> None:
                with parent._lock:
                    parent.requests.append(
                        {
                            "method": "GET",
                            "path": self.path,
                            "headers": {k.lower(): v for k, v in self.headers.items()},
                        }
                    )
                    route = parent.routes.get(self.path)
                    if route is None and "?" in self.path:
                        route = parent.routes.get(self.path.split("?", 1)[0])
                if callable(route):
                    route(self)
                    return
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

        class QuietServer(ThreadingHTTPServer):
            def handle_error(self, request: Any, client_address: Any) -> None:
                return

        self.httpd = QuietServer((host, 0), Handler)
        if ssl_context is not None:
            self.httpd.socket = ssl_context.wrap_socket(self.httpd.socket, server_side=True)
        self.scheme = "https" if ssl_context is not None else "http"
        self.host = host
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path: str) -> str:
        return f"{self.scheme}://{self.host}:{self.port}{path}"

    def count(self, prefix: str | None = None) -> int:
        with self._lock:
            if prefix is None:
                return len(self.requests)
            return sum(1 for r in self.requests if r["path"].startswith(prefix))

    def snapshot_requests(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.requests)

    def clear_requests(self) -> None:
        with self._lock:
            self.requests.clear()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def serve_bytes(
    h: BaseHTTPRequestHandler,
    body: bytes,
    *,
    status: int = 200,
    content_type: str = "application/octet-stream",
    chunked: bool = False,
    content_length_override: int | None = None,
    content_encoding: str | None = None,
    header_delay: float = 0.0,
) -> None:
    if header_delay > 0:
        time.sleep(header_delay)
    h.send_response(status)
    h.send_header("Content-Type", content_type)
    if content_encoding is not None:
        h.send_header("Content-Encoding", content_encoding)
    if chunked:
        h.send_header("Transfer-Encoding", "chunked")
        h.end_headers()
        for i in range(0, len(body), 64):
            piece = body[i : i + 64]
            h.wfile.write(f"{len(piece):x}\r\n".encode("ascii"))
            h.wfile.write(piece)
            h.wfile.write(b"\r\n")
            h.wfile.flush()
        h.wfile.write(b"0\r\n\r\n")
        h.wfile.flush()
    else:
        cl = len(body) if content_length_override is None else content_length_override
        h.send_header("Content-Length", str(cl))
        h.end_headers()
        if body:
            try:
                h.wfile.write(body)
                h.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return


def serve_redirect(
    h: BaseHTTPRequestHandler,
    location: str | None,
    status: int = 302,
    delay: float = 0.0,
) -> None:
    if delay > 0:
        time.sleep(delay)
    h.send_response(status)
    if location is not None:
        h.send_header("Location", location)
    h.send_header("Content-Length", "0")
    h.end_headers()


def repack_tampered_release(src_rel: Path, dst_rel: Path, mutate_fn: Any) -> Path:
    if dst_rel.exists():
        shutil.rmtree(dst_rel)
    dst_rel.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((src_rel / "manifest.json").read_text(encoding="utf-8"))
    raw_sqlite = py_zstd.decompress((src_rel / "corpus.sqlite.zst").read_bytes())
    tampered_db = dst_rel / "tampered.sqlite"
    tampered_db.write_bytes(raw_sqlite)
    with sqlite3.connect(tampered_db) as tconn:
        mutate_fn(tconn)
        tconn.commit()
    tampered_bytes = tampered_db.read_bytes()
    tampered_db.unlink()
    tampered_zst = py_zstd.compress(tampered_bytes)
    (dst_rel / "corpus.sqlite.zst").write_bytes(tampered_zst)
    m_tampered = dict(manifest)
    m_tampered["bytes"] = len(tampered_bytes)
    m_tampered["sha256"] = hashlib.sha256(tampered_bytes).hexdigest()
    m_tampered["compressedBytes"] = len(tampered_zst)
    m_tampered["compressedSha256"] = hashlib.sha256(tampered_zst).hexdigest()
    manifest_out = dst_rel / "manifest.json"
    manifest_out.write_text(json.dumps(m_tampered), encoding="utf-8")
    return manifest_out


def generate_fixture_ca_and_leaf(cert_dir: Path) -> tuple[Path, Path, Path]:
    ca_crt = cert_dir / "ca.crt"
    ca_key = cert_dir / "ca.key"
    ca_cnf = cert_dir / "ca.cnf"
    ca_cnf.write_text(
        "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n"
        "[dn]\nCN=CLEC Fixture CA\n"
        "[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
        encoding="utf-8",
    )
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(ca_key),
            "-out",
            str(ca_crt),
            "-days",
            "2",
            "-config",
            str(ca_cnf),
        ],
        check=True,
        capture_output=True,
    )
    leaf_key = cert_dir / "leaf.key"
    leaf_csr = cert_dir / "leaf.csr"
    leaf_crt = cert_dir / "leaf.crt"
    leaf_cnf = cert_dir / "leaf.cnf"
    leaf_ext = cert_dir / "leaf_ext.cnf"
    leaf_cnf.write_text("[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n", encoding="utf-8")
    leaf_ext.write_text(
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        "subjectAltName=DNS:localhost,IP:127.0.0.1\n",
        encoding="utf-8",
    )
    subprocess.run(
        ["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(leaf_key), "-out", str(leaf_csr), "-config", str(leaf_cnf)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["openssl", "x509", "-req", "-in", str(leaf_csr), "-CA", str(ca_crt), "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(leaf_crt), "-days", "2", "-extfile", str(leaf_ext)],
        check=True,
        capture_output=True,
    )
    return ca_crt, leaf_crt, leaf_key


def main() -> int:
    parser = argparse.ArgumentParser(description="Real-binary Phase 4 HTTP/bootstrap verification matrix")
    parser.add_argument("--clec", required=True, type=Path)
    parser.add_argument("--publish", required=True, type=Path)
    parser.add_argument("--fixture-clec", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--skip-shipped-stall", action="store_true", help="Skip 30s shipped deadline stall test")
    args = parser.parse_args()

    clec_bin = args.clec.resolve()
    pub_bin = args.publish.resolve()
    fix_bin = args.fixture_clec.resolve()
    for b in (clec_bin, pub_bin, fix_bin):
        assert b.is_file(), f"missing binary: {b}"

    clean_env = {
        k: v
        for k, v in os.environ.items()
        if not any(tok in k.upper() for tok in ("API_KEY", "TOKEN", "SECRET"))
    }
    clean_env.pop("CLEC_DATA_DIR", None)

    results: list[dict[str, Any]] = []

    def record(name: str, fn: Any) -> None:
        try:
            detail = fn()
            results.append({"name": name, "status": "PASS", "detail": detail or "ok"})
            print(f"[PASS] {name}: {detail}", flush=True)
        except Exception as exc:
            results.append({"name": name, "status": "FAIL", "detail": f"{type(exc).__name__}: {exc}"})
            print(f"[FAIL] {name}: {type(exc).__name__}: {exc}", flush=True)

    with tempfile.TemporaryDirectory(prefix="clec-v4-matrix-") as td:
        tmp = Path(td)

        # Publish real packages A and B
        ws_a = tmp / "ws_a"
        ws_b = tmp / "ws_b"
        ws_a.mkdir()
        ws_b.mkdir()
        (ws_a / "a.txt").write_text("alpha package 0050 core holding facts.\n", encoding="utf-8")
        (ws_b / "b.txt").write_text("alpha beta package B QQQ 4% withdrawal rules.\n", encoding="utf-8")
        intake_a = tmp / "intake_a.json"
        intake_b = tmp / "intake_b.json"
        intake_a.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "works": [{"key": "work-a", "title": "Work A"}],
                    "sources": [
                        {
                            "work": "work-a",
                            "path": "a.txt",
                            "title": "Source A",
                            "role": "document",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        intake_b.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "works": [{"key": "work-b", "title": "Work B"}],
                    "sources": [
                        {
                            "work": "work-b",
                            "path": "b.txt",
                            "title": "Source B",
                            "role": "document",
                            "attribution": "authored_fixture",
                            "quality": "fixture",
                            "status": "ready",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        rel_a = tmp / "rel_a"
        rel_b = tmp / "rel_b"
        assert run_cli(pub_bin, ["--workspace", str(ws_a), "--intake", str(intake_a), "--output", str(rel_a)], clean_env).returncode == 0
        assert run_cli(pub_bin, ["--workspace", str(ws_b), "--intake", str(intake_b), "--output", str(rel_b)], clean_env).returncode == 0

        m_a_bytes = (rel_a / "manifest.json").read_bytes()
        m_a = json.loads(m_a_bytes.decode("utf-8"))
        z_a_bytes = (rel_a / "corpus.sqlite.zst").read_bytes()
        m_b_bytes = (rel_b / "manifest.json").read_bytes()
        m_b = json.loads(m_b_bytes.decode("utf-8"))
        z_b_bytes = (rel_b / "corpus.sqlite.zst").read_bytes()

        srv = FixtureServer()
        forbidden_srv = FixtureServer()
        cert_dir = tmp / "certs"
        cert_dir.mkdir()
        cert_path, leaf_crt, key_path = generate_fixture_ca_and_leaf(cert_dir)
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(certfile=str(leaf_crt), keyfile=str(key_path))
        https_srv = FixtureServer(ssl_context=ssl_ctx)

        try:
            # Base routes for A and B
            srv.routes["/a/manifest.json"] = lambda h: serve_bytes(h, m_a_bytes, content_type="application/json")
            srv.routes["/a/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_a_bytes)
            srv.routes["/b/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
            srv.routes["/b/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)

            https_srv.routes["/a/manifest.json"] = lambda h: serve_bytes(h, m_a_bytes, content_type="application/json")
            https_srv.routes["/a/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_a_bytes)

            # Package B with explicit artifactUrl
            rel_b_art = tmp / "rel_b_art"
            art_target = srv.url("/signed-bucket/blob.zst?X-Amz-Signature=topsecret123")
            assert (
                run_cli(
                    pub_bin,
                    [
                        "--workspace",
                        str(ws_b),
                        "--intake",
                        str(intake_b),
                        "--output",
                        str(rel_b_art),
                        "--artifact-url",
                        art_target,
                    ],
                    clean_env,
                ).returncode
                == 0
            )
            m_b_art_bytes = (rel_b_art / "manifest.json").read_bytes()

            def test_fresh_http_and_saved_origin() -> str:
                d = tmp / "d_fresh"
                srv.clear_requests()
                res = assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/b/manifest.json")], clean_env)
                )
                assert res["release"] == m_b["sha256"] and res["reused"] is False
                assert srv.count("/b/manifest.json") == 1 and srv.count("/b/corpus.sqlite.zst") == 1
                assert json.loads((d / "active.json").read_text())["manifestPath"] == srv.url("/b/manifest.json")
                assert_no_partial_artifacts(d)

                # Same-release reuse STILL downloads & verifies incoming artifact
                srv.clear_requests()
                reused = assert_ok_json(run_cli(clec_bin, ["--data-dir", str(d), "sync"], clean_env))
                assert reused["reused"] is True
                assert srv.count("/b/manifest.json") == 1 and srv.count("/b/corpus.sqlite.zst") == 1

                # Corrupt incoming bytes on reuse MUST fail even with valid cache
                srv.routes["/bad_reuse/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                corrupt_z = bytearray(z_b_bytes)
                corrupt_z[len(corrupt_z) // 2] ^= 0xFF
                srv.routes["/bad_reuse/corpus.sqlite.zst"] = lambda h: serve_bytes(h, bytes(corrupt_z))
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/bad_reuse/manifest.json")], clean_env),
                    "INTEGRITY_MISMATCH",
                    5,
                )
                assert json.loads((d / "active.json").read_text())["manifestPath"] == srv.url("/b/manifest.json")
                return "fresh HTTP sync, saved origin, same-release reuse verification, and failed override origin preservation verified"

            def test_local_with_artifact_url_offline() -> str:
                d = tmp / "d_local_art"
                srv.clear_requests()
                res = assert_ok_json(
                    run_cli(
                        clec_bin,
                        ["--data-dir", str(d), "--offline", "sync", "--manifest", str(rel_b_art / "manifest.json")],
                        clean_env,
                    )
                )
                assert res["release"] == m_b["sha256"]
                assert srv.count() == 0
                return "local sync with optional artifactUrl read sibling only with 0 HTTP under --offline"

            def test_explicit_override_and_relative_redirect() -> str:
                d = tmp / "d_override"
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                a_state = snapshot_active_state(d)

                # Relative manifest redirect
                srv.routes["/rel-entry"] = lambda h: serve_redirect(h, "/nested/v2/manifest.json")
                srv.routes["/nested/v2/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/nested/v2/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)
                srv.clear_requests()
                res = assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/rel-entry")], clean_env)
                )
                assert res["release"] == m_b["sha256"]
                assert srv.count("/nested/v2/corpus.sqlite.zst") == 1
                assert json.loads((d / "active.json").read_text())["manifestPath"] == srv.url("/rel-entry")

                # Reset to A and test signed-style artifactUrl redirect preserving original manifest URL
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                srv.routes["/stable/latest.json"] = lambda h: serve_redirect(h, "/expiring/manifest.json?Expires=9999&Signature=secretA")
                srv.routes["/expiring/manifest.json"] = lambda h: serve_bytes(h, m_b_art_bytes, content_type="application/json")
                srv.routes["/signed-bucket/blob.zst"] = lambda h: serve_redirect(h, "/cdn-blob/final.zst?token=secretB")
                srv.routes["/cdn-blob/final.zst"] = lambda h: serve_bytes(h, z_b_bytes)
                srv.clear_requests()
                res2 = assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/stable/latest.json")], clean_env)
                )
                assert res2["release"] == m_b["sha256"]
                assert json.loads((d / "active.json").read_text())["manifestPath"] == srv.url("/stable/latest.json")
                assert srv.count("/cdn-blob/final.zst") == 1
                assert srv.count("/expiring/corpus.sqlite.zst") == 0
                _ = a_state
                return "relative manifest redirect, artifactUrl override, signed redirect, and original URL persistence verified"

            def test_redirects_and_forbidden_targets() -> str:
                d = tmp / "d_redir"
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                a_state = snapshot_active_state(d)

                # 5 redirects accepted
                for i in range(1, 6):
                    nxt = "/b/manifest.json" if i == 5 else f"/r5/{i + 1}"
                    srv.routes[f"/r5/{i}"] = lambda h, loc=nxt: serve_redirect(h, loc)
                srv.clear_requests()
                res5 = assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/r5/1")], clean_env)
                )
                assert res5["release"] == m_b["sha256"]
                assert srv.count("/r5/") == 5

                # Re-activate A then fail on 6th redirect & missing Location
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                a_state = snapshot_active_state(d)
                for i in range(1, 7):
                    nxt = "/b/manifest.json" if i == 6 else f"/r6/{i + 1}"
                    srv.routes[f"/r6/{i}"] = lambda h, loc=nxt: serve_redirect(h, loc)
                srv.clear_requests()
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/r6/1")], clean_env),
                    "TRANSFER_FAILED",
                    4,
                )
                assert srv.count("/b/manifest.json") == 0
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                srv.routes["/missing-loc"] = lambda h: serve_redirect(h, None)
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/missing-loc")], clean_env),
                    "TRANSFER_FAILED",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # HTTPS -> HTTP downgrade rejected before forbidden target receives any request
                forbidden_srv.clear_requests()
                https_srv.routes["/downgrade"] = lambda h: serve_redirect(h, forbidden_srv.url("/b/manifest.json"))
                fix_env = dict(clean_env, CLEC_TEST_CA_PEM_PATH=str(cert_path))
                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(d), "sync", "--manifest", https_srv.url("/downgrade")], fix_env),
                    "TRANSFER_FAILED",
                    4,
                )
                assert forbidden_srv.count() == 0
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # file:// redirect rejected
                srv.routes["/file-redir"] = lambda h: serve_redirect(h, f"file://{rel_b / 'manifest.json'}")
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/file-redir")], clean_env),
                    "TRANSFER_FAILED",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Credential URL & non-loopback plain HTTP rejected at CLI boundary
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", "https://user:pass@example.com/m.json"], clean_env),
                    "INVALID_ARGUMENT",
                    2,
                )
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", "http://example.com/m.json"], clean_env),
                    "INVALID_ARGUMENT",
                    2,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)
                return "5 vs 6 redirects, missing Location, HTTPS downgrade, file redirect, credential URL, and non-loopback HTTP verified"

            def test_tls_verification() -> str:
                d = tmp / "d_tls"
                # Shipped binary MUST reject untrusted self-signed cert
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", https_srv.url("/a/manifest.json")], clean_env),
                    "TRANSFER_FAILED",
                    4,
                )
                assert not (d / "active.json").exists()

                # Hostname mismatch rejected even with CA trusted
                fix_env = dict(clean_env, CLEC_TEST_CA_PEM_PATH=str(cert_path))
                mismatch_url = https_srv.url("/a/manifest.json").replace("127.0.0.1", "[::1]")
                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(d), "sync", "--manifest", mismatch_url], fix_env),
                    "TRANSFER_FAILED",
                    4,
                )

                # Valid HTTPS transfer succeeds when fixture CA trusted
                res = assert_ok_json(
                    run_cli(fix_bin, ["--data-dir", str(d), "sync", "--manifest", https_srv.url("/a/manifest.json")], fix_env)
                )
                assert res["release"] == m_a["sha256"]
                return "shipped client rejected untrusted HTTPS cert, hostname mismatch rejected, fixture CA HTTPS succeeded"

            def test_http_statuses_and_framing_and_corruption() -> str:
                d = tmp / "d_framing"
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                a_state = snapshot_active_state(d)

                # 404, 500, 204, 206
                for status_code in (404, 500, 204, 206):
                    srv.routes[f"/st/{status_code}"] = lambda h, sc=status_code: serve_bytes(h, b"err" if sc not in (204,) else b"", status=sc)
                    assert_err_json(
                        run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url(f"/st/{status_code}")], clean_env),
                        "TRANSFER_FAILED",
                        4,
                    )
                    assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Missing Content-Length + chunked valid body succeeds
                srv.routes["/chunked/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json", chunked=True)
                srv.routes["/chunked/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes, chunked=True)
                res_chunked = assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/chunked/manifest.json")], clean_env)
                )
                assert res_chunked["release"] == m_b["sha256"]

                # Restore A for failure checks
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                a_state = snapshot_active_state(d)

                # Incorrect Content-Length
                srv.routes["/badcl/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/badcl/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes, content_length_override=len(z_b_bytes) + 1)
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/badcl/manifest.json")], clean_env),
                    "INTEGRITY_MISMATCH",
                    5,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Excess byte chunked
                srv.routes["/excess/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/excess/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes + b"\x00", chunked=True)
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/excess/manifest.json")], clean_env),
                    "INTEGRITY_MISMATCH",
                    5,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Clean short EOF (chunked)
                srv.routes["/short/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/short/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes[:-1], chunked=True)
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/short/manifest.json")], clean_env),
                    "INTEGRITY_MISMATCH",
                    5,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Abrupt socket close
                def serve_abrupt(h: BaseHTTPRequestHandler) -> None:
                    h.close_connection = True
                    h.send_response(200)
                    h.send_header("Content-Length", str(len(z_b_bytes)))
                    h.end_headers()
                    h.wfile.write(z_b_bytes[: len(z_b_bytes) // 2])
                    h.wfile.flush()
                    try:
                        h.request.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    h.request.close()

                srv.routes["/abrupt/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/abrupt/corpus.sqlite.zst"] = serve_abrupt
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/abrupt/manifest.json")], clean_env),
                    "TRANSFER_FAILED",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Oversized manifest, malformed JSON, bad revisions -> reject BEFORE artifact GET
                srv.routes["/over/manifest.json"] = lambda h: serve_bytes(h, b" " * ((1024 * 1024) + 1), content_type="application/json")
                srv.routes["/over/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)
                srv.routes["/badjson/manifest.json"] = lambda h: serve_bytes(h, b"{not json", content_type="application/json")
                srv.routes["/badjson/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)
                bad_rev_m = dict(m_b, corpusFormat="clec-native-v1")
                srv.routes["/badrev/manifest.json"] = lambda h: serve_bytes(h, json.dumps(bad_rev_m).encode(), content_type="application/json")
                srv.routes["/badrev/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)

                srv.clear_requests()
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/over/manifest.json")], clean_env),
                    "INVALID_MANIFEST",
                    5,
                )
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/badjson/manifest.json")], clean_env),
                    "INVALID_PACKAGE",
                    5,
                )
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/badrev/manifest.json")], clean_env),
                    "INVALID_PACKAGE",
                    5,
                )
                assert srv.count("/over/corpus.sqlite.zst") == 0
                assert srv.count("/badjson/corpus.sqlite.zst") == 0
                assert srv.count("/badrev/corpus.sqlite.zst") == 0
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Non-identity Content-Encoding rejected without hashing client-decoded bytes
                import gzip

                gz_body = gzip.compress(z_b_bytes)
                srv.routes["/ce/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/ce/corpus.sqlite.zst"] = lambda h: serve_bytes(h, gz_body, content_encoding="gzip")
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/ce/manifest.json")], clean_env),
                    "TRANSFER_FAILED",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Compressed SHA mismatch before decode
                bad_csha_m = dict(m_b, compressedSha256="0" * 64)
                srv.routes["/csha/manifest.json"] = lambda h: serve_bytes(h, json.dumps(bad_csha_m).encode(), content_type="application/json")
                srv.routes["/csha/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/csha/manifest.json")], clean_env),
                    "INTEGRITY_MISMATCH",
                    5,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Correct compressed hash but malformed zstd
                bad_z = b"not valid zstd bytes"
                bad_z_m = dict(m_b, compressedBytes=len(bad_z), compressedSha256=hashlib.sha256(bad_z).hexdigest())
                srv.routes["/badz/manifest.json"] = lambda h: serve_bytes(h, json.dumps(bad_z_m).encode(), content_type="application/json")
                srv.routes["/badz/corpus.sqlite.zst"] = lambda h: serve_bytes(h, bad_z)
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/badz/manifest.json")], clean_env),
                    "INVALID_PACKAGE",
                    5,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Correct compressed stream, wrong expanded hash/size
                wrong_exp = py_zstd.compress(b"valid zstd stream wrong sqlite")
                wrong_exp_m = dict(m_b, compressedBytes=len(wrong_exp), compressedSha256=hashlib.sha256(wrong_exp).hexdigest())
                srv.routes["/wexp/manifest.json"] = lambda h: serve_bytes(h, json.dumps(wrong_exp_m).encode(), content_type="application/json")
                srv.routes["/wexp/corpus.sqlite.zst"] = lambda h: serve_bytes(h, wrong_exp)
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/wexp/manifest.json")], clean_env),
                    "INTEGRITY_MISMATCH",
                    5,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Valid hashes but invalid native FTS/canonical state
                tamp_manifest = repack_tampered_release(
                    rel_b,
                    tmp / "tamper_fts",
                    lambda c: c.execute("UPDATE search_data SET block=x'000000' WHERE id=1"),
                )
                tamp_dir = tamp_manifest.parent
                srv.routes["/tamp/manifest.json"] = lambda h: serve_bytes(h, tamp_manifest.read_bytes(), content_type="application/json")
                srv.routes["/tamp/corpus.sqlite.zst"] = lambda h: serve_bytes(h, (tamp_dir / "corpus.sqlite.zst").read_bytes())
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/tamp/manifest.json")], clean_env),
                    "INTEGRITY_MISMATCH",
                    5,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)
                return "404/500/204/206, chunked, CL mismatch, excess, short EOF, abrupt close, oversized/bad manifest, gzip, SHA/zstd/FTS corruptions verified"

            def test_timeouts_and_connect_timeout() -> str:
                d = tmp / "d_timeout"
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                a_state = snapshot_active_state(d)

                fast_env = dict(
                    clean_env,
                    CLEC_TEST_CONNECT_TIMEOUT_MS="250",
                    CLEC_TEST_MANIFEST_TIMEOUT_MS="300",
                    CLEC_TEST_ARTIFACT_TIMEOUT_MS="350",
                )

                # Delayed headers
                srv.routes["/delay-hdr"] = lambda h: serve_bytes(h, m_b_bytes, header_delay=0.6)
                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/delay-hdr")], fast_env),
                    "TRANSFER_TIMEOUT",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Redirects do not reset whole-transfer deadline (2 x 200ms > 300ms)
                srv.routes["/redir-slow-1"] = lambda h: serve_redirect(h, "/redir-slow-2", delay=0.2)
                srv.routes["/redir-slow-2"] = lambda h: serve_redirect(h, "/b/manifest.json", delay=0.2)
                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/redir-slow-1")], fast_env),
                    "TRANSFER_TIMEOUT",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Stalled body and steady trickle
                def serve_stalled(h: BaseHTTPRequestHandler) -> None:
                    h.send_response(200)
                    h.send_header("Content-Length", str(len(z_b_bytes)))
                    h.end_headers()
                    h.wfile.write(z_b_bytes[:10])
                    h.wfile.flush()
                    time.sleep(0.7)

                def serve_trickle(h: BaseHTTPRequestHandler) -> None:
                    h.send_response(200)
                    h.send_header("Content-Length", str(len(z_b_bytes)))
                    h.end_headers()
                    for i in range(0, min(len(z_b_bytes), 200), 10):
                        try:
                            h.wfile.write(z_b_bytes[i : i + 10])
                            h.wfile.flush()
                        except OSError:
                            return
                        time.sleep(0.06)

                srv.routes["/stall/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/stall/corpus.sqlite.zst"] = serve_stalled
                srv.routes["/trickle/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/trickle/corpus.sqlite.zst"] = serve_trickle

                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/stall/manifest.json")], fast_env),
                    "TRANSFER_TIMEOUT",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/trickle/manifest.json")], fast_env),
                    "TRANSFER_TIMEOUT",
                    4,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Deterministic loopback connect timeout via saturated backlog
                backlog_srv = socket.socket()
                backlog_srv.bind(("127.0.0.1", 0))
                backlog_srv.listen(1)
                b_port = backlog_srv.getsockname()[1]
                filler = socket.socket()
                filler.settimeout(1.0)
                filler.connect(("127.0.0.1", b_port))
                conn_env = dict(
                    clean_env,
                    CLEC_TEST_CONNECT_TIMEOUT_MS="200",
                    CLEC_TEST_MANIFEST_TIMEOUT_MS="3000",
                )
                t0 = time.monotonic()
                conn_proc = run_cli(
                    fix_bin,
                    ["--data-dir", str(d), "sync", "--manifest", f"http://127.0.0.1:{b_port}/m.json"],
                    conn_env,
                )
                elapsed = time.monotonic() - t0
                filler.close()
                backlog_srv.close()
                assert_err_json(conn_proc, "TRANSFER_TIMEOUT", 4)
                assert elapsed < 1.5, f"expected ~200ms connect timeout, took {elapsed:.2f}s"

                # One real-CLI stall at shipped 30s manifest deadline
                if not args.skip_shipped_stall:
                    srv.routes["/shipped-stall"] = lambda h: serve_bytes(h, m_b_bytes, header_delay=31.5)
                    t_s = time.monotonic()
                    shipped_proc = run_cli(
                        clec_bin,
                        ["--data-dir", str(d), "sync", "--manifest", srv.url("/shipped-stall")],
                        clean_env,
                        timeout=45.0,
                    )
                    shipped_elapsed = time.monotonic() - t_s
                    assert_err_json(shipped_proc, "TRANSFER_TIMEOUT", 4)
                    assert 28.0 <= shipped_elapsed <= 35.0, f"unexpected shipped stall elapsed {shipped_elapsed:.2f}s"
                    assert_a_preserved(clec_bin, d, clean_env, *a_state)
                return "header/body/trickle/redirect-chain/connect timeouts + shipped 30s real-CLI stall verified"

            def test_budget_obstruction_lock_and_kill() -> str:
                d = tmp / "d_lock"
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                a_state = snapshot_active_state(d)

                # Tiny output budget
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "--max-bytes", "1", "sync", "--manifest", srv.url("/b/manifest.json")], clean_env),
                    "OUTPUT_BUDGET_TOO_SMALL",
                    2,
                )
                assert_a_preserved(clec_bin, d, clean_env, *a_state)

                # Obstruction on active.json replacement
                obs_d = tmp / "d_obs"
                assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(obs_d), "sync", "--manifest", srv.url("/a/manifest.json")], clean_env)
                )
                (obs_d / "active.json").unlink()
                (obs_d / "active.json").mkdir()
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(obs_d), "sync", "--manifest", srv.url("/b/manifest.json")], clean_env),
                    "IO_ERROR",
                    4,
                )
                assert (obs_d / f"{m_a['sha256']}.sqlite").is_file()
                assert not (obs_d / f"{m_b['sha256']}.sqlite").exists()

                # Concurrent lock owner + kill owner mid-transfer + retry
                started = threading.Event()
                allow_finish = threading.Event()

                def serve_gated(h: BaseHTTPRequestHandler) -> None:
                    h.send_response(200)
                    h.send_header("Content-Length", str(len(z_b_bytes)))
                    h.end_headers()
                    h.wfile.write(z_b_bytes[:10])
                    h.wfile.flush()
                    started.set()
                    allow_finish.wait(timeout=10.0)

                srv.routes["/gated/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
                srv.routes["/gated/corpus.sqlite.zst"] = serve_gated

                owner = subprocess.Popen(
                    [str(clec_bin), "--data-dir", str(d), "sync", "--manifest", srv.url("/gated/manifest.json")],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=clean_env,
                )
                assert started.wait(timeout=5.0), "owner did not start transfer"
                srv.clear_requests()
                loser = run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/b/manifest.json")], clean_env)
                assert_err_json(loser, "SYNC_LOCKED", 4)
                assert srv.count() == 0

                # Kill owner mid-transfer (OS releases lock; retry discards stale staging)
                owner.send_signal(signal.SIGKILL)
                owner.wait(timeout=5)
                allow_finish.set()
                assert_a_preserved(clec_bin, d, clean_env, *a_state, check_partials=False)

                # Corrected retry succeeds without manual cleanup and cleans stale temp files
                res_retry = assert_ok_json(
                    run_cli(clec_bin, ["--data-dir", str(d), "sync", "--manifest", srv.url("/b/manifest.json")], clean_env)
                )
                assert res_retry["release"] == m_b["sha256"]
                assert_no_partial_artifacts(d)
                return "tiny budget, active.json obstruction, concurrent SYNC_LOCKED, SIGKILL recovery, and retry verified"

            def test_bootstrap_offline_dryrun_relocation() -> str:
                # 1. Ordinary build honest NO_DATA and schema defaultConfigured=false
                ord_d = tmp / "d_ord"
                ord_sc = assert_ok_json(run_cli(clec_bin, ["--data-dir", str(ord_d), "schema"], clean_env))
                assert ord_sc["defaultConfigured"] is False and ord_sc["phase"] == "phase4"
                assert "http_bootstrap" not in {u["name"] for u in ord_sc["unsupportedFeatures"]}
                assert not ord_d.exists()
                assert_err_json(run_cli(clec_bin, ["--data-dir", str(ord_d), "search", "alpha"], clean_env), "NO_DATA", 3)

                # 2. Fixture build with injected default URL
                boot_env = dict(clean_env, CLEC_TEST_DEFAULT_MANIFEST=srv.url("/b/manifest.json"))
                fix_sc = assert_ok_json(run_cli(fix_bin, ["--data-dir", str(ord_d), "schema"], boot_env))
                assert fix_sc["defaultConfigured"] is True

                # status/schema/help/version cold & warm make 0 HTTP requests and 0 writes
                cold_d = tmp / "d_cold_local"
                srv.clear_requests()
                st_cold = assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "status"], boot_env))
                assert st_cold["ready"] is False and not cold_d.exists()
                assert run_cli(fix_bin, ["--help"], boot_env).returncode == 0
                assert run_cli(fix_bin, ["--version"], boot_env).returncode == 0
                assert srv.count() == 0

                # Cold offline evidence -> NO_DATA, 0 HTTP, 0 writes
                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(cold_d), "--offline", "search", "alpha"], boot_env),
                    "NO_DATA",
                    3,
                )
                assert not cold_d.exists() and srv.count() == 0

                # Cold malformed query/filter/date/ID/combo -> 0 HTTP, 0 writes
                for bad_args, exp_code in [
                    (["search", "   "], "INVALID_QUERY"),
                    (["search", "alpha", "--date-from", "2025-05-02", "--date-to", "2025-05-01"], "INVALID_ARGUMENT"),
                    (["read", "bad_id"], "INVALID_REFERENCE"),
                    (["read", "p_000000000000000000000000", "--original"], "INVALID_ARGUMENT"),
                    (["sources", "--limit", "101"], "INVALID_ARGUMENT"),
                ]:
                    assert_err_json(run_cli(fix_bin, ["--data-dir", str(cold_d), *bad_args], boot_env), exp_code, 2)
                assert not cold_d.exists() and srv.count() == 0

                # Dry-run remote with no cache: only manifest GET, 0 artifact GETs, 0 writes
                srv.clear_requests()
                dry = assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "sync", "--dry-run"], boot_env))
                assert dry["dryRun"] is True and dry["isActive"] is False and dry["release"] == m_b["sha256"]
                assert srv.count("/b/manifest.json") == 1 and srv.count("/b/corpus.sqlite.zst") == 0
                assert not cold_d.exists()

                # Offline remote dry-run rejected
                srv.clear_requests()
                assert_err_json(
                    run_cli(fix_bin, ["--data-dir", str(cold_d), "--offline", "sync", "--dry-run"], boot_env),
                    "OFFLINE_REQUIRED",
                    2,
                )
                assert srv.count() == 0

                # Cold valid search bootstraps once, returns only search output, warm repeat makes 0 HTTP
                srv.clear_requests()
                s_res = assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "search", "alpha"], boot_env))
                assert s_res["release"] == m_b["sha256"] and len(s_res["hits"]) == 1
                assert srv.count("/b/manifest.json") == 1 and srv.count("/b/corpus.sqlite.zst") == 1

                srv.clear_requests()
                assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "search", "alpha"], boot_env))
                assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "--offline", "search", "alpha"], boot_env))
                srcs = assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "sources"], boot_env))
                assert len(srcs["items"]) == 1
                pid = s_res["hits"][0]["passageId"]
                assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "read", pid], boot_env))
                assert srv.count() == 0

                # Dry-run on warm cache shows isActive=True, 0 artifact GETs
                dry_warm = assert_ok_json(run_cli(fix_bin, ["--data-dir", str(cold_d), "sync", "--dry-run"], boot_env))
                assert dry_warm["isActive"] is True and srv.count("/b/corpus.sqlite.zst") == 0

                # Offline sync with saved remote origin rejected with 0 HTTP
                srv.clear_requests()
                assert_err_json(
                    run_cli(clec_bin, ["--data-dir", str(cold_d), "--offline", "sync"], clean_env),
                    "OFFLINE_REQUIRED",
                    2,
                )
                assert srv.count() == 0

                # Cold bootstrap with missing valid ID, release pin mismatch, and tiny query budget leave cache usable offline
                for sub_name, sub_args, exp_code, exp_exit in [
                    ("miss_id", ["read", "p_000000000000000000000000"], "EVIDENCE_NOT_FOUND", 3),
                    ("pin_mismatch", ["search", "alpha", "--release", "0" * 64], "VERSION_UNAVAILABLE", 3),
                    ("tiny_budget", ["--max-bytes", "80", "search", "alpha"], "OUTPUT_BUDGET_TOO_SMALL", 2),
                ]:
                    bd = tmp / f"d_boot_{sub_name}"
                    srv.clear_requests()
                    assert_err_json(run_cli(fix_bin, ["--data-dir", str(bd), *sub_args], boot_env), exp_code, exp_exit)
                    assert srv.count("/b/manifest.json") == 1 and srv.count("/b/corpus.sqlite.zst") == 1
                    srv.clear_requests()
                    warm = assert_ok_json(run_cli(fix_bin, ["--data-dir", str(bd), "search", "alpha"], boot_env))
                    assert warm["release"] == m_b["sha256"] and srv.count() == 0

                # Corrupt active.json or missing active DB -> error without auto-download
                srv.clear_requests()
                corrupt_d = tmp / "d_corrupt"
                shutil.copytree(cold_d, corrupt_d)
                (corrupt_d / "active.json").write_text("{corrupt", encoding="utf-8")
                assert_err_json(run_cli(fix_bin, ["--data-dir", str(corrupt_d), "search", "alpha"], boot_env), "INVALID_PACKAGE", 5)

                missing_db_d = tmp / "d_missing_db"
                shutil.copytree(cold_d, missing_db_d)
                (missing_db_d / f"{m_b['sha256']}.sqlite").unlink()
                assert_err_json(run_cli(fix_bin, ["--data-dir", str(missing_db_d), "search", "alpha"], boot_env), "INVALID_PACKAGE", 5)
                assert srv.count() == 0

                # Move cache & remove publisher files
                moved_remote = tmp / "d_moved_remote"
                shutil.move(str(cold_d), str(moved_remote))
                assert_ok_json(run_cli(clec_bin, ["--data-dir", str(moved_remote), "--offline", "search", "alpha"], clean_env))
                assert_ok_json(run_cli(clec_bin, ["--data-dir", str(moved_remote), "sync"], clean_env))["reused"] is True

                loc_rel = tmp / "rel_temp_local"
                shutil.copytree(rel_a, loc_rel)
                loc_d = tmp / "d_local_orig"
                assert_ok_json(run_cli(clec_bin, ["--data-dir", str(loc_d), "sync", "--manifest", str(loc_rel / "manifest.json")], clean_env))
                shutil.rmtree(loc_rel)
                moved_local = tmp / "d_moved_local"
                shutil.move(str(loc_d), str(moved_local))
                assert_ok_json(run_cli(clec_bin, ["--data-dir", str(moved_local), "--offline", "search", "alpha"], clean_env))
                assert_err_json(run_cli(clec_bin, ["--data-dir", str(moved_local), "sync"], clean_env), "IO_ERROR", 4)
                return "ordinary build, bootstrap, dry-run, offline, corrupt state, and relocation all verified"

            record("fresh_http_reuse_and_corrupt_reuse", test_fresh_http_and_saved_origin)
            record("local_sync_with_artifact_url_offline", test_local_with_artifact_url_offline)
            record("override_relative_redirect_and_signed_artifact_url", test_explicit_override_and_relative_redirect)
            record("redirects_downgrade_file_credentials_nonloopback", test_redirects_and_forbidden_targets)
            record("tls_untrusted_mismatch_and_fixture_ca", test_tls_verification)
            record("http_status_framing_and_package_corruptions", test_http_statuses_and_framing_and_corruption)
            record("timeouts_trickle_connect_and_shipped_stall", test_timeouts_and_connect_timeout)
            record("budget_obstruction_lock_and_kill_retry", test_budget_obstruction_lock_and_kill)
            record("bootstrap_offline_dryrun_corrupt_and_relocation", test_bootstrap_offline_dryrun_relocation)
        finally:
            srv.close()
            forbidden_srv.close()
            https_srv.close()

    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    report = {
        "summary": {
            "total": len(results),
            "passed": passed,
            "failed": failed,
            "allPassed": failed == 0,
        },
        "checks": results,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"]))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
