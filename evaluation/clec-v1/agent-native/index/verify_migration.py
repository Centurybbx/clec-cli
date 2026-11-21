#!/usr/bin/env python3
"""Compare citation identity and revalidate development anchors across local releases."""

import argparse
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "phase3"))
from score import CorpusIndexView, stream_sha256, validate_dataset_against_db


TABLES = (
    "works", "sources", "source_canonical_map", "passages", "passage_spans",
    "cues", "inventory",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("original", "rebuilt", "dataset", "output"):
        parser.add_argument(f"--{flag}", type=Path, required=True)
    args = parser.parse_args()
    dataset = json.loads(args.dataset.read_bytes())
    if dataset["split"] != "development":
        parser.error("only development labels are eligible")
    paths = {}
    for side in ("original", "rebuilt"):
        directory = getattr(args, side).resolve(strict=True)
        release = json.loads((directory / "active.json").read_bytes())["release"]
        paths[side] = directory / f"{release}.sqlite"
        with CorpusIndexView.open_active(directory, release) as corpus:
            labels = {**dataset, "corpusSha256": release}
            errors = validate_dataset_against_db(labels, corpus, release)
            if errors:
                raise ValueError(f"{side} development anchors failed: {len(errors)} errors")
    if dataset["corpusSha256"] != paths["original"].stem:
        raise ValueError("Original release differs from the development label pin")
    counts = {}
    with sqlite3.connect(paths["original"].as_uri() + "?mode=ro", uri=True) as db:
        db.execute("ATTACH DATABASE ? AS rebuilt", (paths["rebuilt"].as_uri() + "?mode=ro",))
        for table in TABLES:
            counts[table] = [
                db.execute(f"SELECT count(*) FROM (SELECT * FROM {left}.{table} EXCEPT SELECT * FROM {right}.{table})").fetchone()[0]
                for left, right in (("main", "rebuilt"), ("rebuilt", "main"))
            ]
        for table in ("blobs",):
            counts[table] = [
                db.execute(f"SELECT count(*) FROM (SELECT content_hash,byte_len FROM {left}.{table} EXCEPT SELECT content_hash,byte_len FROM {right}.{table})").fetchone()[0]
                for left, right in (("main", "rebuilt"), ("rebuilt", "main"))
            ]
        families = dict(db.execute("SELECT key,value FROM rebuilt.metadata WHERE key GLOB 'work_family:*'"))
        revisions = {
            name: db.execute(f"SELECT value FROM {name}.metadata WHERE key='normalization_revision'").fetchone()[0]
            for name in ("main", "rebuilt")
        }
    report = {
        "releases": {side: path.stem for side, path in paths.items()},
        "revisions": revisions, "onlyInOriginalAndRebuilt": counts,
        "developmentQuestionsValidatedOnBoth": len(dataset["questions"]),
        "datasetSha256": stream_sha256(args.dataset),
        "familyKeys": sorted({json.loads(value)["key"] for value in families.values()}),
        "familyMappedWorks": len(families),
    }
    with args.output.open("x") as out:
        json.dump(report, out, indent=2)
        out.write("\n")
    if any(any(pair) for pair in counts.values()):
        raise SystemExit("At least one citation table differs across snapshots. Inspect the private report.")
    print(args.output)


if __name__ == "__main__":
    main()
