#!/usr/bin/env python3
"""Check deterministic rebuilt postings and current, untuned ranking through the CLI."""

import argparse
import json
from pathlib import Path
import sqlite3
import subprocess


def run(binary, *args):
    return json.loads(subprocess.check_output([binary, *args], timeout=60))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(mode=0o700)
    fixture = output / "fixture"
    fixture.mkdir()
    binaries = Path(__file__).resolve().parents[4] / "native/target/release"
    family = {"key": "fixture:editions", "provenance": "fixture publisher edition index"}
    documents = [
        ("lexical", "tokens.txt", "titletoken", "蝴蝶 ＱＱＱ ００５０ ４％"),
        ("questions", "trad.txt", "traditional", "什麼"),
        ("questions", "simple.txt", "simplified", "什么"),
        ("questions", "variant.txt", "variant", "什幺"),
        ("numbers", "near.txt", "numbers", "50 4"),
        ("A", "a1.txt", "rank", "anchor left"),
        ("A", "a2.txt", "rank", "anchor west"),
        ("A", "a3.txt", "rank", "anchor east"),
        ("B", "b1.txt", "rank", "anchor right"),
    ]
    for _, path, _, body in documents:
        (fixture / path).write_text(body, encoding="utf-8")
    intake = output / "intake.json"
    intake.write_text(json.dumps({
        "schemaVersion": 1,
        "works": [{"key": key, "title": key, **({"family": family} if key in {"A", "B"} else {})} for key in sorted({d[0] for d in documents})],
        "sources": [
            {"work": key, "path": path, "title": title, "role": "document",
             "attribution": "authored_fixture", "quality": "fixture", "status": "ready"}
            for key, path, title, _ in documents
        ],
    }))
    runs = []
    identity = None
    for name in ("first", "second"):
        package = output / f"{name}-release"
        release = run(binaries / "clec-publish", "--workspace", fixture, "--intake", intake,
                      "--output", package)
        state = output / f"{name}-state"

        def clec(*tail):
            return run(binaries / "clec", "--offline", "--json", "--data-dir", state, *tail)["data"]

        assert clec("sync", "--manifest", package / "manifest.json")["release"] == release["sha256"]
        database = state / f"{release['sha256']}.sqlite"
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            db.execute("CREATE VIRTUAL TABLE temp.tokens USING fts5vocab(main, search, instance)")
            postings = list(db.execute(
                "SELECT s.path, t.term, t.col, t.offset FROM temp.tokens t "
                "JOIN passages p ON p.rowid=t.doc JOIN sources s ON s.id=p.source_id "
                "ORDER BY s.path, t.col, t.offset"
            ))
            passages = dict(db.execute("SELECT s.path,p.id FROM passages p JOIN sources s ON s.id=p.source_id"))
        if identity is None:
            identity = dict(passages)
        assert passages == identity
        expected = {
            "tokens.txt": (["titletoken"], ["蝴蝶", "qqq", "0050", "4%"]),
            "near.txt": (["numbers"], ["50", "4"]),
            "trad.txt": (["traditional"], ["什么"]),
            "simple.txt": (["simplified"], ["什么"]),
            "variant.txt": (["variant"], ["什么"]),
            "a1.txt": (["rank"], ["anchor", "left"]),
            "a2.txt": (["rank"], ["anchor", "west"]),
            "a3.txt": (["rank"], ["anchor", "east"]),
            "b1.txt": (["rank"], ["anchor", "right"]),
        }
        golden = sorted(
            (path, "t" + token.encode().hex(), column, offset)
            for path, columns in expected.items()
            for column, tokens in zip(("title_tokens", "body_tokens"), columns, strict=True)
            for offset, token in enumerate(tokens)
        )
        assert sorted(postings) == golden
        for query, path in (("titletoken", "tokens.txt"), ("ＱＱＱ", "tokens.txt"),
                            ("0050", "tokens.txt"), ("４％", "tokens.txt"),
                            ("50", "near.txt"), ("4", "near.txt"), ("蝴蝶", "tokens.txt")):
            hits = clec("search", query, "--release", release["sha256"])["hits"]
            assert [h["passageId"] for h in hits] == [passages[path]], query
            original = (fixture / path).read_bytes()
            excerpt = hits[0]["excerptSpan"]
            assert original[excerpt["startByte"]:excerpt["endByte"]].decode() == hits[0]["excerpt"]
            item = clec("read", passages[path], "--release", release["sha256"])["items"][0]
            assert item["text"] == original.decode()
        question_ids = sorted(passages[path] for path in ("trad.txt", "simple.txt", "variant.txt"))
        for query in ("什么", "什麼", "什幺"):
            hits = clec("search", query)["hits"]
            assert [hit["passageId"] for hit in hits] == question_ids
            assert all("familyKey" not in hit["work"] for hit in hits)
            for hit in hits:
                item = clec("read", hit["passageId"])["items"][0]
                assert "family" not in item["work"]
                assert item["text"] == (fixture / item["source"]["path"]).read_text(encoding="utf-8")
        pointer = (state / "active.json").read_bytes()
        forged = package / "wrong-normalization.json"
        forged.write_text(json.dumps({**release, "normalizationRevision": "opencc-tw2s-nfkc-lower-v1"}))
        rejected = subprocess.run([binaries / "clec", "--offline", "--json", "--data-dir", state,
                                   "sync", "--manifest", forged], capture_output=True, timeout=30)
        assert rejected.returncode != 0 and not rejected.stdout
        assert json.loads(rejected.stderr)["error"]["code"] == "INVALID_PACKAGE"
        assert (state / "active.json").read_bytes() == pointer
        raw = sorted(passages[path] for path in ("a1.txt", "a2.txt", "a3.txt", "b1.txt"))
        b = passages["b1.txt"]
        first_a = next(pid for pid in raw if pid != b)
        chosen = [raw[0], first_a if raw[0] == b else b]
        expected_backfill = chosen + [pid for pid in raw if pid not in chosen]
        for cap, expected_order in (("5", raw), ("1", expected_backfill)):
            hits = clec("search", "anchor", "--limit", "4", "--per-work", cap)["hits"]
            assert [h["passageId"] for h in hits] == expected_order
        editions = clec("read", passages["a1.txt"], b)["items"]
        assert editions[0]["work"]["workId"] != editions[1]["work"]["workId"]
        assert editions[0]["source"]["sourceId"] != editions[1]["source"]["sourceId"]
        assert all(item["work"]["family"] == family for item in editions)
        assert all(hit["work"]["familyKey"] == family["key"] for hit in hits)
        fused = clec("search", "anchor", "right", "--limit", "4", "--per-work", "5")["hits"]
        assert [hit["passageId"] for hit in fused] == [b] + [pid for pid in raw if pid != b]
        runs.append({"release": release["sha256"], "archive": release["compressedSha256"],
                     "postings": len(postings), "tiedOrder": raw, "diverseOrder": expected_backfill})
    assert runs[0] == runs[1]
    (output / "receipt.json").write_text(json.dumps({"builds": runs, "lexicalQueriesPerBuild": 10, "familyEditionIdsRemainDistinct": True, "wrongRevisionRejectsBeforeActivation": True}, indent=2) + "\n")
    print(output / "receipt.json")


if __name__ == "__main__":
    main()
