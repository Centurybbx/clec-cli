#!/usr/bin/env python3
"""Summarize local Jev usage evidence without emitting request text or credentials."""

import argparse
import json
from pathlib import Path
from statistics import median


def native_rows(path):
    cases = json.loads(path.read_bytes())["cases"]
    rows = []
    for case in cases:
        first = case["steps"][0]
        if first["exitCode"] != 0:
            continue
        data = json.loads(first["stdoutUtf8"])["data"]
        usage, calls, consumption = data["usage"], data["calls"], data["consumption"]
        if usage["status"] != "reported":
            continue
        rows.append({
            "actualModel": data["actualModel"],
            "calls": calls["successfulBatches"],
            "requests": calls["httpAttempts"],
            "requestBodyBytes": consumption["requestBytes"],
            "inputTokens": usage["inputTokens"],
            "outputTokens": usage["outputTokens"],
            "estimatedUnits": consumption["estimatedTokenUnits"],
            "contextOmitted": data["candidateCounts"]["contextOmittedCount"],
        })
    return rows


def usage_fields(raw):
    return (raw.get("input_tokens", raw.get("prompt_tokens", raw.get("inputTokens"))),
            raw.get("output_tokens", raw.get("completion_tokens", raw.get("outputTokens"))))


def python_rows(root, seen):
    rows = []
    for path in sorted(root.rglob("attempt-*.json")):
        record = json.loads(path.read_bytes())
        if record.get("status") != 200 or not record.get("usage"):
            continue
        response = json.loads(record["raw_response"])
        if response["id"] in seen:
            continue
        seen.add(response["id"])
        assert usage_fields(record["usage"]) == usage_fields(response["usage"])
        input_tokens, output_tokens = usage_fields(record["usage"])
        request = record["request"]
        size = len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode())
        count = len(request["questions"])
        rows.append((size, count, input_tokens, output_tokens))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilot", type=Path, required=True)
    parser.add_argument("--fit-archive", type=Path, required=True)
    parser.add_argument("--validation-archive", type=Path, required=True)
    args = parser.parse_args()
    seen = set()
    fit = python_rows(args.fit_archive, seen)
    validation = python_rows(args.validation_archive, seen)
    token_per_byte = sum(row[2] for row in fit) / sum(row[0] for row in fit)
    output_per_question = sum(row[3] for row in fit) / sum(row[1] for row in fit)
    input_errors = [abs(token_per_byte * row[0] / row[2] - 1) for row in validation]
    output_errors = [abs(output_per_question * row[1] / row[3] - 1) for row in validation]
    native = native_rows(args.pilot / "sag2-combined-observations.json")
    smoke = native_rows(args.pilot / "smoke-observations.json")
    print(json.dumps({
        "nativeSmoke": smoke,
        "nativeCompleted": native,
        "historicalPythonForecast": {
            "fitCalls": len(fit), "validationCalls": len(validation),
            "inputTokensPerCompactJsonByte": token_per_byte,
            "outputTokensPerQuestion": output_per_question,
            "inputMedianAndMaxRelativeError": [median(input_errors), max(input_errors)],
            "outputMedianAndMaxRelativeError": [median(output_errors), max(output_errors)],
        },
    }, indent=2))


if __name__ == "__main__":
    main()
