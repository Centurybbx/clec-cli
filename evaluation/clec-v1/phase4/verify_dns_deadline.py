#!/usr/bin/env python3
"""Real-CLI verification suite for Stage 4 DNS, setup/cleanup, and direct-proxy bounds."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import runpy
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Any

PHASE4_MOD = runpy.run_path(str(Path(__file__).with_name("verify_phase4.py")))
FixtureServer = PHASE4_MOD["FixtureServer"]
serve_bytes = PHASE4_MOD["serve_bytes"]
serve_redirect = PHASE4_MOD["serve_redirect"]
generate_fixture_ca_and_leaf = PHASE4_MOD["generate_fixture_ca_and_leaf"]
assert_ok_json = PHASE4_MOD["assert_ok_json"]
assert_err_json = PHASE4_MOD["assert_err_json"]
snapshot_active_state = PHASE4_MOD["snapshot_active_state"]
assert_no_partial_artifacts = PHASE4_MOD["assert_no_partial_artifacts"]

DELAY_C_SRC = r"""#include <netdb.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
static int delayed(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
    if (node && strcmp(node, "localhost") == 0) {
        fprintf(stderr, "PROBE resolver entered\n");
        fflush(stderr);
        usleep(1500000);
        fprintf(stderr, "PROBE resolver returned\n");
        fflush(stderr);
    }
    return getaddrinfo(node, service, hints, res);
}
__attribute__((used)) static struct {
    const void *replacement;
    const void *replacee;
} hook __attribute__((section("__DATA,__interpose"))) = {
    (const void *)delayed,
    (const void *)getaddrinfo
};
"""


def run_cli_timed(
    binary: Path,
    args: list[str],
    env: dict[str, str],
    timeout: float = 10.0,
) -> tuple[subprocess.CompletedProcess[str], float]:
    t0 = time.monotonic()
    proc = subprocess.run(
        [str(binary), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )
    return proc, time.monotonic() - t0


def extract_cli_json_stderr(stderr_text: str) -> str:
    for line in reversed(stderr_text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            return stripped
    return stderr_text


def read_hook_log(path: Path) -> list[str]:
    if not path.is_file():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage 4 DNS deadline and direct-proxy CLI suite")
    parser.add_argument("--clec", required=True, type=Path)
    parser.add_argument("--publish", required=True, type=Path)
    parser.add_argument("--fixture-clec", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    clec_bin = args.clec.resolve()
    pub_bin = args.publish.resolve()
    fix_bin = args.fixture_clec.resolve()
    for b in (clec_bin, pub_bin, fix_bin):
        assert b.is_file(), f"missing binary: {b}"

    clean_env = {
        k: v
        for k, v in os.environ.items()
        if "proxy" not in k.lower()
        and not k.startswith("CLEC_")
        and not any(tok in k.upper() for tok in ("API_KEY", "TOKEN", "SECRET"))
    }

    results: list[dict[str, Any]] = []

    def record(name: str, fn: Any) -> None:
        try:
            detail = fn()
            results.append({"name": name, "status": "PASS", "detail": detail or "ok"})
            print(f"[PASS] {name}: {detail}", flush=True)
        except Exception as exc:
            results.append({"name": name, "status": "FAIL", "detail": f"{type(exc).__name__}: {exc}"})
            print(f"[FAIL] {name}: {type(exc).__name__}: {exc}", flush=True)

    with tempfile.TemporaryDirectory(prefix="clec-v4-dns-") as td:
        tmp = Path(td)
        ws_a = tmp / "ws_a"
        ws_b = tmp / "ws_b"
        ws_a.mkdir()
        ws_b.mkdir()
        (ws_a / "a.txt").write_text("alpha DNS baseline fixture.\n", encoding="utf-8")
        (ws_b / "b.txt").write_text("beta DNS blocked fixture.\n", encoding="utf-8")

        intake_a = tmp / "intake_a.json"
        intake_b = tmp / "intake_b.json"
        for p, wk, fname in [
            (intake_a, "work-a", "a.txt"),
            (intake_b, "work-b", "b.txt"),
        ]:
            p.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "works": [{"key": wk, "title": wk}],
                        "sources": [
                            {
                                "work": wk,
                                "path": fname,
                                "title": wk,
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
        assert subprocess.run(
            [str(pub_bin), "--workspace", str(ws_a), "--intake", str(intake_a), "--output", str(rel_a)],
            capture_output=True,
            env=clean_env,
        ).returncode == 0
        assert subprocess.run(
            [str(pub_bin), "--workspace", str(ws_b), "--intake", str(intake_b), "--output", str(rel_b)],
            capture_output=True,
            env=clean_env,
        ).returncode == 0

        m_a_bytes = (rel_a / "manifest.json").read_bytes()
        m_a = json.loads(m_a_bytes.decode("utf-8"))
        z_a_bytes = (rel_a / "corpus.sqlite.zst").read_bytes()
        m_b_bytes = (rel_b / "manifest.json").read_bytes()
        m_b = json.loads(m_b_bytes.decode("utf-8"))
        z_b_bytes = (rel_b / "corpus.sqlite.zst").read_bytes()

        cert_dir = tmp / "certs"
        cert_dir.mkdir()
        ca_crt, leaf_crt, leaf_key = generate_fixture_ca_and_leaf(cert_dir)
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(str(leaf_crt), str(leaf_key))

        http_srv = FixtureServer()
        https_srv = FixtureServer(ssl_context=ssl_ctx)
        proxy_srv = FixtureServer()

        try:
            http_srv.routes["/a/manifest.json"] = lambda h: serve_bytes(h, m_a_bytes, content_type="application/json")
            http_srv.routes["/a/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_a_bytes)
            http_srv.routes["/b/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
            http_srv.routes["/b/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)

            split_m_http = dict(m_b, artifactUrl=http_srv.url("/b/corpus.sqlite.zst").replace("127.0.0.1", "localhost"))
            http_srv.routes["/b/split-manifest.json"] = lambda h: serve_bytes(
                h, json.dumps(split_m_http).encode(), content_type="application/json"
            )

            https_srv.routes["/b/manifest.json"] = lambda h: serve_bytes(h, m_b_bytes, content_type="application/json")
            https_srv.routes["/b/corpus.sqlite.zst"] = lambda h: serve_bytes(h, z_b_bytes)
            split_m_https = dict(m_b, artifactUrl=https_srv.url("/b/corpus.sqlite.zst").replace("127.0.0.1", "localhost"))
            https_srv.routes["/b/split-manifest.json"] = lambda h: serve_bytes(
                h, json.dumps(split_m_https).encode(), content_type="application/json"
            )

            delay_dylib: Path | None = None
            if sys.platform == "darwin" and shutil.which("cc"):
                delay_c = tmp / "delay.c"
                delay_c.write_text(DELAY_C_SRC, encoding="utf-8")
                dylib_out = tmp / "delay.dylib"
                cc_proc = subprocess.run(
                    ["cc", "-shared", "-fPIC", str(delay_c), "-o", str(dylib_out)],
                    capture_output=True,
                    text=True,
                )
                if cc_proc.returncode == 0 and dylib_out.is_file():
                    delay_dylib = dylib_out

            def test_macos_real_getaddrinfo_interpose() -> str:
                if delay_dylib is None:
                    return "skipped (non-darwin or no cc)"
                measurements: dict[str, float] = {}
                for label, srv, extra in [
                    ("http", http_srv, {}),
                    ("https", https_srv, {"CLEC_TEST_CA_PEM_PATH": str(ca_crt)}),
                ]:
                    srv.clear_requests()
                    url = srv.url("/b/manifest.json").replace("127.0.0.1", "localhost")
                    env = clean_env | extra | {
                        "DYLD_INSERT_LIBRARIES": str(delay_dylib),
                        "CLEC_TEST_MANIFEST_TIMEOUT_MS": "100",
                    }
                    proc, elapsed = run_cli_timed(
                        fix_bin,
                        ["--data-dir", str(tmp / f"d_interpose_{label}"), "sync", "--dry-run", "--manifest", url],
                        env,
                    )
                    assert proc.returncode == 4, (label, proc.returncode, proc.stderr)
                    assert proc.stdout == "", (label, proc.stdout)
                    assert "PROBE resolver entered" in proc.stderr, (label, proc.stderr)
                    assert "PROBE resolver returned" not in proc.stderr, (
                        f"{label} waited for 1.5s resolver completion instead of returning at budget ({elapsed:.3f}s)"
                    )
                    assert elapsed < 0.75, f"{label} took {elapsed:.3f}s >= 0.75s"
                    err_obj = json.loads(extract_cli_json_stderr(proc.stderr))
                    assert err_obj["error"]["code"] == "TRANSFER_TIMEOUT", err_obj
                    assert srv.count() == 0, (label, srv.snapshot_requests())
                    measurements[label] = round(elapsed, 4)

                    srv.clear_requests()
                    off_proc, _ = run_cli_timed(
                        fix_bin,
                        ["--data-dir", str(tmp / f"d_interpose_off_{label}"), "--offline", "sync", "--dry-run", "--manifest", url],
                        env,
                    )
                    assert off_proc.returncode == 2, (label, off_proc.stderr)
                    assert "PROBE resolver entered" not in off_proc.stderr
                    off_err = json.loads(extract_cli_json_stderr(off_proc.stderr))
                    assert off_err["error"]["code"] == "OFFLINE_REQUIRED"
                    assert srv.count() == 0
                return f"HTTP {measurements['http']}s, HTTPS {measurements['https']}s (<0.75s, 0 target GETs, offline 0 DNS)"

            def test_portable_resolver_delay_manifest_and_artifact() -> str:
                details = []
                for label, srv, extra in [
                    ("http", http_srv, {}),
                    ("https", https_srv, {"CLEC_TEST_CA_PEM_PATH": str(ca_crt)}),
                ]:
                    hook_log = tmp / f"hook_manifest_{label}.log"
                    srv.clear_requests()
                    env = clean_env | extra | {
                        "CLEC_TEST_MANIFEST_TIMEOUT_MS": "100",
                        "CLEC_TEST_RESOLVER_DELAY_MS": "1500",
                        "CLEC_TEST_RESOLVER_DELAY_HOST": "localhost",
                        "CLEC_TEST_HOOK_LOG_PATH": str(hook_log),
                    }
                    url = srv.url("/b/manifest.json").replace("127.0.0.1", "localhost")
                    proc, elapsed = run_cli_timed(
                        fix_bin,
                        ["--data-dir", str(tmp / f"d_port_m_{label}"), "sync", "--dry-run", "--manifest", url],
                        env,
                    )
                    assert_err_json(proc, "TRANSFER_TIMEOUT", 4)
                    assert elapsed < 0.75, f"{label} manifest stall took {elapsed:.3f}s"
                    entries = read_hook_log(hook_log)
                    assert any(e.startswith("resolve_enter:localhost:") for e in entries), entries
                    assert not any(e.startswith("resolve_exit:localhost:") for e in entries), entries
                    assert srv.count() == 0

                    art_log = tmp / f"hook_art_{label}.log"
                    srv.clear_requests()
                    env_art = clean_env | extra | {
                        "CLEC_TEST_MANIFEST_TIMEOUT_MS": "3000",
                        "CLEC_TEST_ARTIFACT_TIMEOUT_MS": "100",
                        "CLEC_TEST_RESOLVER_DELAY_MS": "1500",
                        "CLEC_TEST_RESOLVER_DELAY_HOST": "localhost",
                        "CLEC_TEST_HOOK_LOG_PATH": str(art_log),
                    }
                    proc_a, elapsed_a = run_cli_timed(
                        fix_bin,
                        [
                            "--data-dir",
                            str(tmp / f"d_port_a_{label}"),
                            "sync",
                            "--manifest",
                            srv.url("/b/split-manifest.json"),
                        ],
                        env_art,
                    )
                    assert_err_json(proc_a, "TRANSFER_TIMEOUT", 4)
                    assert elapsed_a < 0.75, f"{label} artifact stall took {elapsed_a:.3f}s"
                    art_entries = read_hook_log(art_log)
                    assert any(e.startswith("resolve_enter:localhost:") for e in art_entries), art_entries
                    assert not any(e.startswith("resolve_exit:localhost:") for e in art_entries), art_entries
                    assert srv.count("/b/split-manifest.json") == 1
                    assert srv.count("/b/corpus.sqlite.zst") == 0
                    details.append(f"{label}(m={elapsed:.3f}s,a={elapsed_a:.3f}s)")
                return ", ".join(details)

            def test_literal_redirect_shares_budget_with_localhost_dns() -> str:
                http_srv.routes["/slow-redir"] = lambda h: serve_redirect(
                    h, http_srv.url("/b/manifest.json").replace("127.0.0.1", "localhost"), delay=0.12
                )
                hook_log = tmp / "hook_redir.log"
                http_srv.clear_requests()
                env = clean_env | {
                    "CLEC_TEST_MANIFEST_TIMEOUT_MS": "200",
                    "CLEC_TEST_RESOLVER_DELAY_MS": "150",
                    "CLEC_TEST_RESOLVER_DELAY_HOST": "localhost",
                    "CLEC_TEST_HOOK_LOG_PATH": str(hook_log),
                }
                proc, elapsed = run_cli_timed(
                    fix_bin,
                    ["--data-dir", str(tmp / "d_redir_budget"), "sync", "--dry-run", "--manifest", http_srv.url("/slow-redir")],
                    env,
                )
                assert_err_json(proc, "TRANSFER_TIMEOUT", 4)
                assert elapsed < 0.75, f"redirect budget stall took {elapsed:.3f}s"
                assert http_srv.count("/slow-redir") == 1
                assert http_srv.count("/b/manifest.json") == 0
                entries = read_hook_log(hook_log)
                assert entries.count("worker_spawn") == 1, entries
                assert any(e.startswith("resolve_enter:localhost:") for e in entries), entries
                return f"shared budget expired in {elapsed:.3f}s with 1 worker and 0 target GETs"

            def test_active_a_preserved_and_lock_reacquirable() -> str:
                d = tmp / "d_a_to_b"
                assert_ok_json(
                    subprocess.run(
                        [str(clec_bin), "--data-dir", str(d), "sync", "--manifest", http_srv.url("/a/manifest.json")],
                        capture_output=True,
                        text=True,
                        env=clean_env,
                    )
                )
                a_state = snapshot_active_state(d)
                for target in (
                    http_srv.url("/b/manifest.json").replace("127.0.0.1", "localhost"),
                    http_srv.url("/b/split-manifest.json"),
                ):
                    http_srv.clear_requests()
                    env = clean_env | {
                        "CLEC_TEST_MANIFEST_TIMEOUT_MS": "3000",
                        "CLEC_TEST_ARTIFACT_TIMEOUT_MS": "100",
                        "CLEC_TEST_RESOLVER_DELAY_MS": "1500",
                        "CLEC_TEST_RESOLVER_DELAY_HOST": "localhost",
                    }
                    if "split-manifest" not in target:
                        env["CLEC_TEST_MANIFEST_TIMEOUT_MS"] = "100"
                    proc, elapsed = run_cli_timed(
                        fix_bin,
                        ["--data-dir", str(d), "sync", "--manifest", target],
                        env,
                    )
                    assert_err_json(proc, "TRANSFER_TIMEOUT", 4)
                    assert elapsed < 0.75, f"A->B stall took {elapsed:.3f}s"
                    assert http_srv.count("/b/manifest.json") == 0
                    assert http_srv.count("/b/corpus.sqlite.zst") == 0
                    active_now, rel_now, db_sha_now = snapshot_active_state(d)
                    assert (active_now, rel_now, db_sha_now) == a_state
                    assert_no_partial_artifacts(d)
                    reacq = subprocess.run(
                        [str(clec_bin), "--data-dir", str(d), "sync"],
                        capture_output=True,
                        text=True,
                        env=clean_env,
                    )
                    assert assert_ok_json(reacq)["reused"] is True
                return "A metadata/DB unchanged, staging empty, lock immediately reacquirable"

            def test_offline_zero_worker_and_local_artifact_url() -> str:
                hook_log = tmp / "hook_offline.log"
                env = clean_env | {
                    "CLEC_TEST_RESOLVER_DELAY_MS": "1500",
                    "CLEC_TEST_HOOK_LOG_PATH": str(hook_log),
                }
                for srv in (http_srv, https_srv):
                    srv.clear_requests()
                    url = srv.url("/b/manifest.json").replace("127.0.0.1", "localhost")
                    proc, elapsed = run_cli_timed(
                        fix_bin,
                        ["--data-dir", str(tmp / "d_off"), "--offline", "sync", "--manifest", url],
                        env,
                    )
                    assert_err_json(proc, "OFFLINE_REQUIRED", 2)
                    assert elapsed < 0.75
                    assert srv.count() == 0

                local_rel = tmp / "local_with_url"
                shutil.copytree(rel_b, local_rel)
                local_m = dict(m_b, artifactUrl=http_srv.url("/b/must-not-fetch.zst").replace("127.0.0.1", "localhost"))
                local_m_path = local_rel / "manifest.json"
                local_m_path.write_text(json.dumps(local_m), encoding="utf-8")
                http_srv.clear_requests()
                proc_loc, _ = run_cli_timed(
                    fix_bin,
                    ["--data-dir", str(tmp / "d_off_loc"), "--offline", "sync", "--manifest", str(local_m_path)],
                    env,
                )
                assert assert_ok_json(proc_loc)["release"] == m_b["sha256"]
                assert http_srv.count() == 0
                assert read_hook_log(hook_log) == []
                return "0 worker spawns, 0 DNS entries, 0 HTTP for remote offline and local offline with artifactUrl"

            def test_setup_and_cleanup_delays() -> str:
                setup_log = tmp / "hook_setup.log"
                http_srv.clear_requests()
                proc_s, elapsed_s = run_cli_timed(
                    fix_bin,
                    ["--data-dir", str(tmp / "d_setup"), "sync", "--dry-run", "--manifest", http_srv.url("/b/manifest.json")],
                    clean_env | {
                        "CLEC_TEST_MANIFEST_TIMEOUT_MS": "100",
                        "CLEC_TEST_SETUP_DELAY_MS": "1500",
                        "CLEC_TEST_HOOK_LOG_PATH": str(setup_log),
                    },
                )
                assert_err_json(proc_s, "TRANSFER_TIMEOUT", 4)
                assert elapsed_s < 0.75, f"setup delay took {elapsed_s:.3f}s"
                assert http_srv.count() == 0
                setup_entries = read_hook_log(setup_log)
                assert "setup_enter" in setup_entries and "setup_exit" not in setup_entries, setup_entries

                cleanup_log = tmp / "hook_cleanup.log"
                d_clean = tmp / "d_cleanup"
                http_srv.clear_requests()
                proc_c, elapsed_c = run_cli_timed(
                    fix_bin,
                    ["--data-dir", str(d_clean), "sync", "--manifest", http_srv.url("/b/manifest.json")],
                    clean_env | {
                        "CLEC_TEST_MANIFEST_TIMEOUT_MS": "150",
                        "CLEC_TEST_CLEANUP_DELAY_MS": "1500",
                        "CLEC_TEST_HOOK_LOG_PATH": str(cleanup_log),
                    },
                )
                assert_err_json(proc_c, "TRANSFER_TIMEOUT", 4)
                assert elapsed_c < 0.75, f"cleanup delay took {elapsed_c:.3f}s"
                assert not (d_clean / "active.json").exists()
                cleanup_entries = read_hook_log(cleanup_log)
                assert "cleanup_enter" in cleanup_entries and "cleanup_exit" not in cleanup_entries, cleanup_entries
                return f"setup={elapsed_s:.3f}s (0 GETs), cleanup={elapsed_c:.3f}s (EOF did not bypass cleanup)"

            def test_synthetic_proxy_env_ignored_direct_only() -> str:
                proxy_url = f"http://127.0.0.1:{proxy_srv.port}"
                proxy_env = {
                    "HTTP_PROXY": proxy_url,
                    "HTTPS_PROXY": proxy_url,
                    "ALL_PROXY": proxy_url,
                    "http_proxy": proxy_url,
                    "https_proxy": proxy_url,
                    "all_proxy": proxy_url,
                    "NO_PROXY": "",
                    "no_proxy": "",
                }
                proxy_srv.clear_requests()
                http_srv.clear_requests()
                res_http = subprocess.run(
                    [str(clec_bin), "--data-dir", str(tmp / "d_proxy_http"), "sync", "--manifest", http_srv.url("/a/manifest.json")],
                    capture_output=True,
                    text=True,
                    env=clean_env | proxy_env,
                )
                assert assert_ok_json(res_http)["release"] == m_a["sha256"]
                assert proxy_srv.count() == 0
                assert http_srv.count("/a/manifest.json") == 1 and http_srv.count("/a/corpus.sqlite.zst") == 1

                proxy_srv.clear_requests()
                https_srv.clear_requests()
                res_https = subprocess.run(
                    [str(fix_bin), "--data-dir", str(tmp / "d_proxy_https"), "sync", "--manifest", https_srv.url("/b/manifest.json")],
                    capture_output=True,
                    text=True,
                    env=clean_env | proxy_env | {"CLEC_TEST_CA_PEM_PATH": str(ca_crt)},
                )
                assert assert_ok_json(res_https)["release"] == m_b["sha256"]
                assert proxy_srv.count() == 0
                assert https_srv.count("/b/manifest.json") == 1 and https_srv.count("/b/corpus.sqlite.zst") == 1

                bad_proxy_log = tmp / "hook_proxy.log"
                bad_proxy_url = "http://proxy.invalid.test:3128"
                bad_proxy_env = {
                    "HTTP_PROXY": bad_proxy_url,
                    "HTTPS_PROXY": bad_proxy_url,
                    "ALL_PROXY": bad_proxy_url,
                    "http_proxy": bad_proxy_url,
                    "https_proxy": bad_proxy_url,
                    "all_proxy": bad_proxy_url,
                    "NO_PROXY": "none.invalid",
                    "no_proxy": "none.invalid",
                    "CLEC_TEST_CA_PEM_PATH": str(ca_crt),
                    "CLEC_TEST_HOOK_LOG_PATH": str(bad_proxy_log),
                }
                res_bad_proxy = subprocess.run(
                    [str(fix_bin), "--data-dir", str(tmp / "d_proxy_host"), "sync", "--manifest", https_srv.url("/b/manifest.json")],
                    capture_output=True,
                    text=True,
                    env=clean_env | bad_proxy_env,
                )
                assert assert_ok_json(res_bad_proxy)["release"] == m_b["sha256"]
                entries = read_hook_log(bad_proxy_log)
                assert not any("proxy.invalid.test" in e for e in entries), entries
                return "0 proxy requests, 0 proxy-host DNS resolutions, direct HTTP & HTTPS succeeded"

            record("macos_real_getaddrinfo_interpose", test_macos_real_getaddrinfo_interpose)
            record("portable_resolver_delay_manifest_and_artifact", test_portable_resolver_delay_manifest_and_artifact)
            record("literal_redirect_shares_budget_with_localhost_dns", test_literal_redirect_shares_budget_with_localhost_dns)
            record("active_a_preserved_and_lock_reacquirable", test_active_a_preserved_and_lock_reacquirable)
            record("offline_zero_worker_and_local_artifact_url", test_offline_zero_worker_and_local_artifact_url)
            record("setup_and_cleanup_delays", test_setup_and_cleanup_delays)
            record("synthetic_proxy_env_ignored_direct_only", test_synthetic_proxy_env_ignored_direct_only)
        finally:
            http_srv.close()
            https_srv.close()
            proxy_srv.close()

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
