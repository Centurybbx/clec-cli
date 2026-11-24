"""Reproduce the DuRetrieval benchmark with pinned public parquet files."""

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import subprocess
import statistics
import time
import unicodedata

REVISION = "8d9b3d6a6a62b7fd2d4df0821d612366dc52d14e"
ROOT = Path("/tmp/clec-stage0-bench")
SHA256 = {
    "corpus": "dc60d5f9b5a642371c19602c94e79b4a6df2e1a667b0642d0980f4e47f072df2",
    "queries": "bfb7b9433ab3ccbb1f18d1ded6f6ce8f3988f2bf65f374735714a26ba09089ea",
    "data": "e310a25c8cfe7164fc4bed6e115dc9b43b02a8399c44e61ca28cadda93ae2ad4",
}



def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8") as output:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def read_jsonl(path):
    with path.open(encoding="utf-8") as source:
        for line in source:
            yield json.loads(line)


def valid_digest(path, expected):
    if not path.is_file():
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == expected


def prepare(root):
    import pyarrow.parquet as pq

    root.mkdir(parents=True, exist_ok=True)
    for part in ("corpus", "queries", "data"):
        path = root / f"{part}.parquet"
        if not valid_digest(path, SHA256[part]):
            url = (
                f"https://huggingface.co/datasets/mteb/DuRetrieval/resolve/{REVISION}/"
                f"{part}/dev-00000-of-00001.parquet?download=true"
            )
            temporary = path.with_suffix(".part")
            subprocess.run([
                "curl", "-fsSL", "--fail-early", "--retry", "5", "--retry-all-errors",
                "--continue-at", "-", url, "-o", temporary,
            ], check=True)
            if not valid_digest(temporary, SHA256[part]):
                raise ValueError(f"unexpected SHA-256 for {temporary}")
            temporary.replace(path)

    corpus = pq.ParquetFile(root / "corpus.parquet")
    queries = pq.read_table(root / "queries.parquet").to_pylist()
    qrels = pq.read_table(root / "data.parquet").to_pylist()
    assert corpus.metadata.num_rows == 100_001
    assert len(queries) == len({row["_id"] for row in queries}) == 2_000
    assert len(qrels) == 9_839
    assert {row["query-id"] for row in qrels} == {row["_id"] for row in queries}

    def passages():
        for batch in corpus.iter_batches():
            for row in batch.to_pylist():
                yield {
                    "doc_id": row["_id"],
                    "work_id": row["_id"],
                    "source_id": row["_id"],
                    "ordinal": 0,
                    "kind": "doc",
                    "quality": 1,
                    "title": row["title"],
                    "body": row["text"],
                }

    write_jsonl(root / "corpus.jsonl", passages())
    write_jsonl(root / "queries.jsonl", queries)
    write_jsonl(root / "qrels.jsonl", qrels)
    lengths = collections.Counter(len(row["text"]) for row in queries)
    print(json.dumps({
        "passages": corpus.metadata.num_rows,
        "queries": len(queries),
        "qrels": len(qrels),
        "query_length_histogram": dict(sorted(lengths.items())),
        "with_whitespace": sum(any(char.isspace() for char in row["text"]) for row in queries),
    }))


def baseline(root):
    import bm25s
    import jieba

    def tokenize(text):
        return [
            token for token in jieba.cut(unicodedata.normalize("NFKC", text).casefold(), HMM=True)
            if any(char.isalnum() for char in token)
        ]

    ids = []
    tokens = []
    for row in read_jsonl(root / "corpus.jsonl"):
        ids.append(row["doc_id"])
        tokens.append(tokenize(row["title"] + " " + row["body"]))
    assert len(ids) == len(set(ids)) == 100_001
    index = bm25s.BM25(method="lucene", k1=1.2, b=0.75, backend="numpy")
    index.index(tokens, show_progress=False)
    del tokens
    queries = [tokenize(row["text"]) for row in read_jsonl(root / "queries.jsonl")]
    ranking = index.retrieve(queries, k=100, return_as="tuple", show_progress=False)
    write_jsonl(root / "baseline.jsonl", (
        [ids[doc] for doc, score in zip(docs, scores) if score > 0]
        for docs, scores in zip(ranking.documents, ranking.scores)
    ))


def evaluate(root, binary, stopwords):
    queries = list(read_jsonl(root / "queries.jsonl"))
    qrels = collections.defaultdict(dict)
    for row in read_jsonl(root / "qrels.jsonl"):
        qrels[row["query-id"]][row["corpus-id"]] = row["score"]

    ranking_path = root / (f"tantivy-{stopwords}.jsonl" if stopwords else "tantivy.jsonl")
    options = ["--stopwords", stopwords] if stopwords else []
    with ranking_path.open("w", encoding="utf-8") as output:
        subprocess.run(
            [binary, "batch", "--index", root / "index", "--limit", "100", *options],
            input=query_lines(row["text"] for row in queries),
            encoding="utf-8", stdout=output, check=True,
        )

    def scores(rankings, selected):
        sums = [0.0, 0.0, 0.0]
        for i in selected:
            relevant = qrels[queries[i]["_id"]]
            ranking = rankings[i]
            ideal = sum((2 ** score - 1) / math.log2(pos + 2)
                        for pos, score in enumerate(sorted(relevant.values(), reverse=True)[:10]))
            observed = sum((2 ** relevant.get(doc, 0) - 1) / math.log2(pos + 2)
                           for pos, doc in enumerate(ranking[:10]))
            sums[0] += observed / ideal
            sums[1] += len(set(ranking[:100]).intersection(relevant)) / len(relevant)
            sums[2] += not ranking
        return dict(zip(("ndcg@10", "recall@100", "zero_hits"), (
            sums[0] / len(selected), sums[1] / len(selected), int(sums[2])
        )), queries=len(selected))

    groups = {
        "all": list(range(len(queries))),
        "length_ge_15": [i for i, row in enumerate(queries) if len(row["text"]) >= 15],
    }
    rankings = {
        "jieba_bm25": list(read_jsonl(root / "baseline.jsonl")),
        "tantivy": [[hit["doc_id"] for hit in row] for row in read_jsonl(ranking_path)],
    }
    for rows in rankings.values():
        assert len(rows) == len(queries)
        assert all(len(row) == len(set(row)) <= 100 for row in rows)
    print(json.dumps({
        name: {group: scores(rows, selected) for group, selected in groups.items()}
        for name, rows in rankings.items()
    }, indent=2))


def query_lines(queries):
    return "".join(json.dumps(query, ensure_ascii=False) + "\n" for query in queries)


def distribution(values):
    return {
        "n": len(values),
        "min": min(values),
        "p50": statistics.median(values),
        "p95": sorted(values)[math.ceil(0.95 * len(values)) - 1],
        "max": max(values),
    }


def latency(root, binary, samples, require_full_limit):
    queries = [row["text"] for row in read_jsonl(root / "queries.jsonl")]
    assert 1 <= samples <= len(queries)
    index = root / "index"
    limit = 15

    def call(query, profile=False):
        flags = ["--timings"] if profile else []
        start = time.perf_counter_ns()
        output = subprocess.check_output(
            [binary, "search", "--index", index, "--limit", str(limit), *flags, "--", query],
        )
        elapsed = (time.perf_counter_ns() - start) / 1e6
        response = json.loads(output)
        hits = response["hits"] if profile else response
        assert all("snippet" in hit for hit in hits)
        return elapsed, response

    first, first_hits = call(queries[0])
    positions = [(i * len(queries)) // samples for i in range(samples)]
    warmup = [queries[i] for i in positions[:10]]
    for query in warmup:
        call(query)
    if require_full_limit:
        sampled = set(positions)
        positions.extend(i for i in range(len(queries)) if i not in sampled)
    measurements = []
    skipped = []
    for i in positions:
        query = queries[i]
        wall_ms, hits = call(query)
        if require_full_limit and len(hits) < limit:
            skipped.append({"query": query, "hits": len(hits)})
            continue
        measurements.append({"query": query, "elapsed_ms": wall_ms, "hits": len(hits)})
        if len(measurements) == samples:
            break
    if len(measurements) != samples:
        raise ValueError(f"only {len(measurements)} queries met the sample requirements")
    selected = [row["query"] for row in measurements]

    profiled = []
    for query in selected[::5]:
        wall_ms, profile = call(query, profile=True)
        profiled.append({
            "query": query,
            "wall_ms": wall_ms,
            "exec_exit_io_ms": wall_ms - profile["in_main_ms"],
            "before_index_open_ms": profile["before_open_ms"],
            "index_open_ms": profile["index_open_ms"],
            "jieba_init_ms": profile["jieba_init_ms"],
            "zhconv_init_ms": profile["zhconv_init_ms"],
            **profile["query"],
        })

    start = time.perf_counter_ns()
    hot = subprocess.check_output(
        [binary, "batch", "--index", index, "--limit", str(limit), "--snippets", "--timings"],
        input=query_lines(warmup + selected), encoding="utf-8",
    )
    batch_wall = (time.perf_counter_ns() - start) / 1e6
    rows = [json.loads(line) for line in hot.splitlines()]
    assert len(rows) == len(warmup) + samples
    for hits, _ in rows:
        assert all("snippet" in hit for hit in hits)
    hot_timings = [timing for _, timing in rows[len(warmup):]]

    print(json.dumps({
        "first_process_ms": first,
        "first_query": queries[0],
        "first_query_hits": len(first_hits),
        "warmup_processes": len(warmup),
        "warm_external_ms": distribution([row["elapsed_ms"] for row in measurements]),
        "snippet_counts": dict(collections.Counter(row["hits"] for row in measurements)),
        "skipped_under_limit": skipped,
        "external_breakdown_ms": {
            key: distribution([row[key] for row in profiled])
            for key in profiled[0] if key != "query"
        },
        "batch_wall_ms_including_startup_and_warmup": batch_wall,
        "batch_steady_state_ms": {
            key: distribution([row[key] for row in hot_timings]) for key in hot_timings[0]
        },
    }, indent=2))
    write_jsonl(root / "latency-samples.jsonl", measurements)
    write_jsonl(root / "latency-external-profile.jsonl", profiled)
    write_jsonl(root / "latency-batch-profile.jsonl", hot_timings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "baseline", "evaluate", "latency"))
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--binary", type=Path, default=Path("target/release/clec"))
    parser.add_argument("--samples", type=int, default=200)
    parser.add_argument("--stopwords", choices=("compact", "expanded", "none"))
    parser.add_argument("--require-full-limit", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.root)
    elif args.command == "baseline":
        baseline(args.root)
    elif args.command == "evaluate":
        evaluate(args.root, args.binary, args.stopwords)
    else:
        latency(args.root, args.binary, args.samples, args.require_full_limit)


if __name__ == "__main__":
    main()
