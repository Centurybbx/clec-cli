#!/usr/bin/env python3
"""Run a paired development check against the native CLI and local corpus."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from score import stream_sha256


HERE = Path(__file__).resolve().parent
HOST_BYTE_CAP = 32_768
READ_TOP_N = 3
PROFILES = {"search": ("search", 0), "searchRead": ("search-read", READ_TOP_N)}
METRICS = (
    "status", "stopReason", "completeChain", "coveredObligations",
    "conditionsCovered", "counterexamplesCovered",
)


def load_json(path):
    return json.loads(path.read_bytes())


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_profile(output, args, dataset, release, read_top_n):
    output.mkdir()
    command = [
        sys.executable, str(HERE / "eval.py"), "run",
        "--clec", str(args.clec), "--data-dir", str(args.data_dir),
        "--dataset", str(dataset), "--corpus-sha256", release,
        "--max-bytes", str(HOST_BYTE_CAP), "--read-max-bytes", str(HOST_BYTE_CAP),
        "--read-top-n", str(read_top_n), "--raw-logs", str(output / "calls.jsonl"),
        "--outcomes-out", str(output / "outcomes.json"), "--output", str(output / "report.json"),
    ]
    with (output / "evaluator.stdout").open("xb") as stdout, (
        output / "evaluator.stderr"
    ).open("xb") as stderr:
        result = subprocess.run(command, stdout=stdout, stderr=stderr)
    report = load_json(output / "report.json")
    if result.returncode not in (0, 1) or report["verdict"] not in (
        "complete", "inconclusive_errors_present"
    ):
        raise ValueError(f"{output.name}: evaluator could not score the run. See {output}")
    return report, load_json(output / "outcomes.json")


def compare_questions(before_report, after_report):
    before_rows = {row["id"]: row for row in before_report["perQuestion"]}
    after_rows = {row["id"]: row for row in after_report["perQuestion"]}
    if before_rows.keys() != after_rows.keys():
        raise ValueError("Question coverage differs between reports")
    changes = []
    for qid, row in before_rows.items():
        before = {key: row.get(key) for key in METRICS}
        after = {key: after_rows[qid].get(key) for key in METRICS}
        if before != after:
            changes.append({"id": qid, "before": before, "after": after})
    return changes


def paired_changes(search_report, read_report, search_outcomes, read_outcomes):
    def first_steps(outcomes):
        result = {}
        for outcome in outcomes:
            step = outcome["steps"][0]
            if step["step"] != "search" or outcome["id"] in result:
                raise ValueError("Expected one initial search for each unique question")
            result[outcome["id"]] = {
                key: value for key, value in step.items() if key != "elapsedSeconds"
            }
        return result

    searches = first_steps(search_outcomes)
    if searches != first_steps(read_outcomes):
        raise ValueError("Initial search observations differ between profiles")
    if {row["id"] for row in search_report["perQuestion"]} != searches.keys():
        raise ValueError("Question coverage differs between observations and reports")
    return compare_questions(search_report, read_report)


def compare_baseline(path, reports):
    changes = {}
    for name, (directory, _) in PROFILES.items():
        before = load_json(path / directory / "report.json")
        after = reports[name]
        if any(before[key] != after[key] for key in ("actualCorpusSha256", "datasetSha256")):
            raise ValueError("Baseline uses a different corpus or dataset")
        before_config, after_config = (
            {k: v for k, v in report["config"].items() if k not in ("clec", "dataDir")}
            for report in (before, after)
        )
        if before_config != after_config:
            raise ValueError(f"Baseline uses different settings for {name}")
        changes[name] = compare_questions(before, after)
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clec", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True, help="Phase 3 development JSON")
    parser.add_argument("--output", type=Path, required=True, help="New private run directory")
    parser.add_argument("--baseline", type=Path, help="Previous paired run directory")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.clec = args.clec.resolve(strict=True)
    args.data_dir = args.data_dir.resolve(strict=True)
    dataset_bytes = args.dataset.read_bytes()
    dataset = json.loads(dataset_bytes)
    if dataset.get("split") != "development" or not any(
        question.get("answerable") is True for question in dataset.get("questions", [])
    ):
        parser.error("a development dataset with answerable questions is required")
    release = dataset["corpusSha256"]

    args.output.mkdir(mode=0o700)
    dataset_copy = args.output / "dataset.json"
    dataset_copy.write_bytes(dataset_bytes)
    binary_digest = stream_sha256(args.clec)
    runs = {
        name: run_profile(args.output / directory, args, dataset_copy, release, read_top_n)
        for name, (directory, read_top_n) in PROFILES.items()
    }
    reports = {name: report for name, (report, _) in runs.items()}
    if stream_sha256(args.clec) != binary_digest:
        raise ValueError("CLEC binary changed during verification")
    dataset_digest = stream_sha256(dataset_copy)
    for report in reports.values():
        if report["datasetSha256"] != dataset_digest or report["actualCorpusSha256"] != release:
            raise ValueError("Scored inputs differ from the pinned dataset or corpus")

    summary = {
        "schemaVersion": 1,
        "datasetSha256": dataset_digest,
        "corpusSha256": release,
        "clecSha256": binary_digest,
        "clecVersion": subprocess.check_output(
            [args.clec, "--version"], text=True, timeout=30
        ).strip(),
        "profiles": {
            name: {key: report[key] for key in ("config", "verdict", "counts", "gates")}
            for name, report in reports.items()
        },
        "changes": paired_changes(
            reports["search"], reports["searchRead"], runs["search"][1], runs["searchRead"][1]
        ),
    }
    if args.baseline is not None:
        summary["baselineChanges"] = compare_baseline(args.baseline, reports)
    write_json(args.output / "summary.json", summary)
    print(args.output / "summary.json")
    return 0 if all(all(report["gates"].values()) for report in reports.values()) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as error:
        print(f"Local verification inconclusive: {error}", file=sys.stderr)
        sys.exit(2)
