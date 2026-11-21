#!/usr/bin/env python3
"""Compare offline CLI delivery and score read evidence on the pinned development cases."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "phase3"))
from adapter import run_clec_command
from score import (
    CorpusIndexView, ValidatedEvidenceItem, _build_obligations, _item_covers_evidence,
    stream_sha256, validate_dataset_against_db, validate_returned_item,
)


def read_envelope(call, command, release, cap):
    if call["exitCode"] != 0 or call["timedOut"]:
        if call["stdoutRawByteLen"]:
            raise ValueError(f"{command} failure carried stdout")
        return None
    envelope = json.loads(call["stdout"])
    if (call["stderrRawByteLen"] or envelope["ok"] is not True
            or envelope["schemaVersion"] != 1 or envelope["command"] != command
            or envelope["data"]["release"] != release):
        raise ValueError(f"Invalid {command} envelope")
    data = envelope["data"]
    if not data["budget"]["usedBytes"] == call["stdoutRawByteLen"] <= cap:
        raise ValueError(f"Invalid {command} byte count")
    return data


def validate_lead(lead, corpus):
    """Verify the excerpt, then return its index coordinates for lead location scoring."""
    pid, sid = lead["passageId"], lead["source"]["sourceId"]
    src = corpus.sources[sid]
    indexed = corpus.passage_by_id(pid)
    if (indexed is None or indexed["sourceId"] != sid
            or lead["work"]["workId"] != indexed["workId"]
            or lead["source"]["role"] != src["role"]
            or any(field in lead for field in ("text", "spans", "cues"))):
        raise ValueError(f"Invalid lead identity or shape for {pid}")
    span = lead["excerptSpan"]
    start, end = span["startByte"], span["endByte"]
    raw = corpus.raw_bytes_for_source(sid)
    if (not any(s <= start < end <= e and c == span.get("cueOrdinal")
                for s, e, c in indexed["spans"])
            or raw[start:end].decode("utf-8") != lead["excerpt"]):
        raise ValueError(f"Excerpt does not match the source bytes for {pid}")

    def item(spans):
        return ValidatedEvidenceItem(
            sid, src["workId"], src["role"], src["canonicalSourceId"], src["equivalenceHash"],
            src["projectionKind"], tuple(spans),
        )

    return item([(s, e) for s, e, _ in indexed["spans"]]), item([(start, end)])


def verified_evidence(items, corpus):
    verified = []
    for index, item in enumerate(items):
        result, errors = validate_returned_item(item, corpus, item_index=index)
        if errors or result is None:
            raise ValueError(f"Invalid evidence item {index}: {errors}")
        verified.append(result)
    return verified


def coverage(question, items, corpus):
    obligations = _build_obligations(question["evidence"])
    if not question["answerable"]:
        return None
    covered = []
    for alternatives in obligations:
        anchors = [ev for ev in alternatives if _item_covers_evidence(ev, items, corpus)]
        if anchors:
            covered.append({"claimId": alternatives[0]["claimId"],
                            "kind": alternatives[0]["kind"]})
    return {"covered": covered, "complete": bool(obligations) and len(covered) == len(obligations)}


def run_profile(binary, question, corpus, data_dir, log, cap, limit, *, original):
    release = corpus.actual_sha256

    def run(tail):
        result = run_clec_command(binary, tail, data_dir=data_dir, max_bytes=cap, timeout_sec=30)
        log.write(json.dumps({"questionId": question["id"], **result}, ensure_ascii=False) + "\n")
        return read_envelope(result, tail[0], release, cap)

    search = run(["search", question["question"], "--match-mode", "any", "--per-work", "2",
                  "--limit", str(limit), "--release", release])
    if search is None:
        raise ValueError(f"Search failed for {question['id']}, limit {limit}, cap {cap}")
    hits = search["hits"]
    ids = [hit["passageId"] for hit in hits]
    omitted = search["budget"]["omittedIds"]
    if search["budget"]["omittedCount"] != len(omitted):
        raise ValueError("Search omission count mismatch")
    if not original and (omitted or len(ids) != min(limit, search["totalCandidates"])):
        raise ValueError("Candidate CLI did not deliver the complete selected list")

    if original:
        locations = excerpts = verified_evidence(hits, corpus)
    else:
        pairs = [validate_lead(hit, corpus) for hit in hits]
        locations = [location for location, _ in pairs]
        excerpts = [excerpt for _, excerpt in pairs]

    requested = ids[:3]
    read_items = []
    failed_read = False
    if requested:
        pin = [] if original else ["--release", release]
        read = run(["read", *requested, "--context", "1", *pin])
        failed_read = read is None
        if read is not None:
            read_items = verified_evidence(read["items"], corpus)
            returned = [item["passageId"] for item in read["items"]]
            if returned != requested[:len(returned)]:
                raise ValueError("Read did not deliver an ordered prefix")
            remaining = requested[len(returned):]
            if (len(remaining) != read["budget"]["omittedCount"]
                    or not original and remaining != read["budget"]["omittedIds"]):
                raise ValueError("Read omission list mismatch")
    return {
        "id": question["id"], "totalCandidates": search["totalCandidates"],
        "deliveredIds": ids, "omittedIds": omitted, "requestedRead": len(requested),
        "deliveredRead": len(read_items), "readFailed": failed_read,
        "locatedBySearch": coverage(question, locations, corpus),
        "visibleInSearch": coverage(question, excerpts, corpus),
        "readEvidence": coverage(question, read_items, corpus),
        **({"legacySearchAndReadEvidence": coverage(question, locations + read_items, corpus)}
           if original else {}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("original", "candidate", "dataset", "data-dir", "output"):
        parser.add_argument(f"--{field}", required=True, type=Path)
    args = parser.parse_args()
    dataset = json.loads(args.dataset.read_bytes())
    if dataset["split"] != "development":
        parser.error("this comparison is for development cases")
    release = dataset["corpusSha256"]
    args.output.mkdir(mode=0o700)
    profiles = [(cap, limit) for cap in (32768, 65536) for limit in (5, 10, 20)]
    reports = {}
    with CorpusIndexView.open_active(args.data_dir, release) as corpus:
        errors = validate_dataset_against_db(dataset, corpus, release)
        if errors:
            raise ValueError(f"Invalid development data: {errors}")
        for cap, limit in profiles:
            for mode, binary in [("original", args.original), ("candidate", args.candidate)]:
                if mode == "original" and limit != 5:
                    continue
                key = f"{mode}-{cap}-{limit}"
                with (args.output / f"{key}.jsonl").open("x") as log:
                    reports[key] = [
                        run_profile(binary.resolve(), q, corpus, args.data_dir.resolve(), log,
                                    cap, limit, original=mode == "original")
                        for q in dataset["questions"]
                    ]
            if limit == 5:
                for old, new in zip(reports[f"original-{cap}-5"], reports[f"candidate-{cap}-5"], strict=True):
                    if (old["totalCandidates"] != new["totalCandidates"]
                            or old["deliveredIds"] + old["omittedIds"] != new["deliveredIds"]):
                        raise ValueError(f"Limit-five ranking changed for {old['id']} at {cap}")
        if not corpus.verify_db_file_unchanged():
            raise ValueError("Corpus changed during execution")
    report = {
        "corpusSha256": release, "datasetSha256": stream_sha256(args.dataset),
        "originalSha256": stream_sha256(args.original), "candidateSha256": stream_sha256(args.candidate),
        "profiles": reports,
    }
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(args.output / "report.json")


if __name__ == "__main__":
    main()
