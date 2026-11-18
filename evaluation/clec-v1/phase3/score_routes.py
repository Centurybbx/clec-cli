"""Replay retrieval evidence coverage with alternative sets of source spans."""

import argparse
import hashlib
import json
from pathlib import Path
from statistics import mean
import sys

from score import (
    CorpusIndexView, _item_covers_evidence, validate_dataset_against_db,
    validate_returned_item,
)


def score_obligations(obligations, covers):
    rows = [
        {
            "id": obligation["id"],
            "kind": obligation["kind"],
            "covered": any(
                all(covers(anchor) for anchor in route)
                for route in obligation["routes"]
            ),
        }
        for obligation in obligations
    ]
    covered = sum(row["covered"] for row in rows)
    return {
        "evidenceRecall": covered / len(rows) if rows else None,
        "allEvidence": covered == len(rows) if rows else None,
        "missing": [row for row in rows if not row["covered"]],
    }


def validate_labels(labels, corpus):
    if labels["schemaVersion"] != 1:
        raise ValueError("Unsupported route dataset version")
    questions = []
    for case in labels["cases"]:
        obligations = case["obligations"]
        ids = [item["id"] for item in obligations]
        if len(set(ids)) != len(ids) or bool(obligations) != case["answerable"]:
            raise ValueError(f"{case['id']}: invalid obligations")
        evidence = []
        for obligation in obligations:
            routes = obligation["routes"]
            if not routes or any(not route for route in routes):
                raise ValueError(f"{case['id']}/{obligation['id']}: empty evidence route")
            for route in routes:
                evidence.extend(
                    {**anchor, "claimId": obligation["id"], "kind": obligation["kind"]}
                    for anchor in route
                )
        questions.append({**case, "workKeys": [], "evidence": evidence})
    dataset = {**labels, "questions": questions}
    errors = validate_dataset_against_db(dataset, corpus, labels["corpusSha256"])
    if errors:
        raise ValueError(f"Invalid source annotations: {errors}")


def score_case(case, observation, corpus):
    if observation["question"] != case["question"]:
        raise ValueError(f"{case['id']}: question differs from labels")
    obligations = case["obligations"]
    seen = []
    first_search = None
    attempted_search = False
    first_complete = None
    errors = []

    def coverage(items):
        return score_obligations(
            obligations, lambda anchor: _item_covers_evidence(anchor, items, corpus)
        )

    for number, step in enumerate(observation["steps"], start=1):
        command = step["command"]
        initial_search = command == "search" and not attempted_search
        attempted_search |= command == "search"
        if step["exitCode"] != 0:
            if step["stdoutUtf8"]:
                raise ValueError(f"{case['id']} step {number}: failure has stdout")
            errors.append(number)
            continue
        envelope = json.loads(step["stdoutUtf8"])
        if envelope["command"] != command or not envelope["ok"] or step["stderrUtf8"]:
            raise ValueError(f"{case['id']} step {number}: invalid CLI envelope")
        if command not in ("search", "read"):
            continue
        data = envelope["data"]
        if data["release"] != corpus.actual_sha256:
            raise ValueError(f"{case['id']} step {number}: wrong corpus release")
        items = []
        for index, value in enumerate(data["hits" if command == "search" else "items"]):
            item, failures = validate_returned_item(value, corpus, item_index=index)
            if failures:
                raise ValueError(f"{case['id']} step {number}: {failures}")
            if item is not None:
                items.append(item)
        if initial_search:
            first_search = {str(k): coverage(items[:k]) for k in (1, 2, 5)}
        seen.extend(items)
        if first_complete is None and coverage(seen)["allEvidence"] is True:
            first_complete = number

    return {
        "id": case["id"],
        "category": case["category"],
        "firstSearch": first_search,
        "cumulative": coverage(seen),
        "firstCompleteStep": first_complete,
        "failedSteps": errors,
        "steps": len(observation["steps"]),
    }


def summarize(rows, get_coverage):
    scored = [cell for row in rows if (cell := get_coverage(row)) is not None
              and cell["evidenceRecall"] is not None]
    return {
        "scoredCases": len(scored),
        "meanEvidenceRecall": mean(cell["evidenceRecall"] for cell in scored) if scored else None,
        "allEvidenceCases": sum(cell["allEvidence"] for cell in scored),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("data-dir", "labels", "observations", "output"):
        parser.add_argument(f"--{field}", type=Path, required=True)
    args = parser.parse_args()
    label_bytes = args.labels.read_bytes()
    observation_bytes = args.observations.read_bytes()
    labels = json.loads(label_bytes)
    observations = json.loads(observation_bytes)
    if observations["schemaVersion"] != 1:
        raise ValueError("Unsupported observation version")
    cases = observations["cases"]
    by_id = {case["id"]: case for case in cases}
    if len(by_id) != len(cases) or by_id.keys() != {case["id"] for case in labels["cases"]}:
        raise ValueError("Case IDs differ between labels and observations")
    with CorpusIndexView.open_active(args.data_dir, labels["corpusSha256"]) as corpus:
        validate_labels(labels, corpus)
        rows = [score_case(case, by_id[case["id"]], corpus) for case in labels["cases"]]
        if not corpus.verify_db_file_unchanged():
            raise ValueError("Corpus changed during replay")
    result = {
        "schemaVersion": 1,
        "corpusSha256": labels["corpusSha256"],
        "labelsSha256": hashlib.sha256(label_bytes).hexdigest(),
        "observationsSha256": hashlib.sha256(observation_bytes).hexdigest(),
        "scheduledCases": len(rows),
        "answerableCases": sum(case["answerable"] for case in labels["cases"]),
        "firstSearch": {str(k): summarize(rows, lambda row: (row["firstSearch"] or {}).get(str(k)))
                        for k in (1, 2, 5)},
        "cumulative": summarize(rows, lambda row: row["cumulative"]),
        "cases": rows,
    }
    with args.output.open("x") as target:
        json.dump(result, target, ensure_ascii=False, indent=2)
        target.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"Cannot score retrieval routes: {error}")
