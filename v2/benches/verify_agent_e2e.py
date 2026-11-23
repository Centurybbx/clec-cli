#!/usr/bin/env python3
"""Verify a blind run from captured CLI process results and final answers."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys


HERE = Path(__file__).resolve().parent
DEFAULT_CORPUS = Path("/Users/century/Vibing/clec-corpus/dist/corpus.jsonl")
PRIMARY_KINDS = {"transcript", "doc"}
COMMANDS = {"search", "outline", "read", "stats"}
HELP_FLAGS = {"-h", "--help"}
VERSION_FLAGS = {"-V", "--version"}


def unique_by_id(rows, label):
    if not isinstance(rows, list):
        raise ValueError(f"{label} must be a JSON array")
    by_id = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise ValueError(f"{label} contains a row without a string id")
        if row["id"] in by_id:
            raise ValueError(f"duplicate {label} id: {row['id']}")
        by_id[row["id"]] = row
    return by_id


def load_corpus(path):
    docs = {}
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            start, end = row.get("start_sec"), row.get("end_sec")
            docs[row["doc_id"]] = (
                row["work_id"],
                row.get("origin_url", ""),
                None if start is None and end is None else {"start_sec": start, "end_sec": end},
            )
    if not docs:
        raise ValueError("corpus is empty")
    return docs, {work for work, _, _ in docs.values()}


def object_rows(payload, key, fields):
    rows = payload.get(key)
    if not isinstance(rows, list):
        raise ValueError(f"missing {key} array")
    if any(not isinstance(row, dict) or not fields <= row.keys() for row in rows):
        raise ValueError(f"invalid {key} rows")
    return rows


def id_record(row):
    return all(isinstance(row.get(key), str) and row[key] for key in ("doc_id", "work_id"))


def decode_output(argv, stdout, docs):
    command = argv[0]
    flags = set(argv[1:argv.index("--")]) if "--" in argv else set(argv[1:])
    if command in HELP_FLAGS | VERSION_FLAGS or flags & HELP_FLAGS:
        if not stdout.strip():
            raise ValueError("missing help or version output")
        return {}
    if command == "search" and flags & {"--ids-only", "--brief"}:
        ids = stdout.splitlines()
        if any(doc_id not in docs for doc_id in ids):
            raise ValueError("invalid or unknown ID in --ids-only output")
        return {}

    if command == "search" and "--jsonl" in flags:
        payload = {"hits": [json.loads(line) for line in stdout.splitlines()]}
    else:
        payload = json.loads(stdout)
    if not isinstance(payload, dict):
        raise ValueError("expected a JSON object")

    if command == "search":
        hits = object_rows(payload, "hits", {"doc_id", "work_id"})
        if not all(map(id_record, hits)):
            raise ValueError("search hit lacks string IDs")
    elif command == "outline":
        object_rows(payload, "sources", {"source_id", "kind"})
        object_rows(payload, "passages", {"doc_id", "kind"})
        if not isinstance(payload.get("work_id"), str):
            raise ValueError("outline lacks work_id")
    elif command == "stats":
        gaps = payload.get("known_gaps")
        if not isinstance(gaps, list) or any(not isinstance(gap, str) for gap in gaps):
            raise ValueError("stats lacks known_gaps strings")
        if not isinstance(payload.get("disclaimer"), str):
            raise ValueError("stats lacks disclaimer")
    else:
        readings = object_rows(payload, "passages", {"passage", "before", "after"})
        passages = []
        for row in readings:
            passages.extend([
                row["passage"],
                *object_rows(row, "before", {"doc_id", "work_id", "kind", "body"}),
                *object_rows(row, "after", {"doc_id", "work_id", "kind", "body"}),
            ])
        if any(
            not isinstance(row, dict) or not id_record(row)
            or not isinstance(row.get("body"), str) or not isinstance(row.get("kind"), str)
            for row in passages
        ):
            raise ValueError("invalid read passage")
        payload = {"passages": passages}
    return payload


def is_expected_missing(argv, stderr, gap_id, works):
    if not gap_id or gap_id in works:
        return False
    targets_work = argv[0] == "outline" and gap_id in argv[1:]
    if argv[0] in {"search", "read"}:
        targets_work = (
            any(left == "--work" and right == gap_id for left, right in zip(argv, argv[1:]))
            or f"--work={gap_id}" in argv[1:]
        )
    if not targets_work:
        return False
    error = json.loads(stderr).get("error")
    if not isinstance(error, dict) or not isinstance(error.get("message"), str):
        raise ValueError("missing structured exit-4 error")
    return error.get("code") == 4 and f'work_id "{gap_id}" does not exist' in error["message"]


def verify_commands(commands, gap_id, docs, works):
    counts = Counter()
    issues = []
    outlined = set()
    searched_primary_works = set()
    primary = set()
    gaps = set()
    for i, call in enumerate(commands, 1):
        counts["commands"] += 1
        try:
            argv = call["argv"]
            if (
                not isinstance(argv, list) or not argv
                or any(not isinstance(arg, str) for arg in argv)
                or argv[0] not in COMMANDS | HELP_FLAGS | VERSION_FLAGS
                or type(call["timed_out"]) is not bool
            ):
                raise ValueError("invalid argv or timed_out flag")
            if call["timed_out"]:
                counts["timeout"] += 1
                issues.append(f"命令 {i}（{argv[0]}）超时")
                continue
            if call.get("execution_error"):
                counts["execution"] += 1
                issues.append(f"命令 {i}（{argv[0]}）未能执行")
                continue
            code, stdout, stderr = (call[key] for key in ("exit_code", "stdout", "stderr"))
            if type(code) is not int or not isinstance(stdout, str) or not isinstance(stderr, str):
                raise ValueError("invalid exit code or captured output")
        except (KeyError, TypeError, ValueError) as error:
            counts["capture"] += 1
            issues.append(f"命令 {i} 记录无效（{error}）")
            continue

        try:
            if call.get("parse_error"):
                raise ValueError("解析失败已由记录方捕获")
            if code == 4 and is_expected_missing(argv, stderr, gap_id, works):
                counts["expected_missing"] += 1
                continue
            if code != 0:
                counts["execution"] += 1
                issues.append(f"命令 {i}（{argv[0]}）异常退出 {code}")
                continue
            payload = decode_output(argv, stdout, docs)
        except (AttributeError, ValueError) as error:
            counts["parse"] += 1
            issues.append(f"命令 {i}（{argv[0]}）输出无法解析（{error}）")
            continue

        if argv[0] == "search":
            searched_primary_works.update(
                row["work_id"]
                for row in payload.get("hits", [])
                if row.get("kind") in PRIMARY_KINDS
            )
        elif argv[0] == "outline" and payload.get("passages"):
            outlined.add(payload["work_id"])
        elif argv[0] == "read":
            is_range_read = "--range" in argv[1:] or any(a.startswith("--range=") for a in argv[1:])
            primary.update(
                (row["doc_id"], row["work_id"])
                for row in payload.get("passages", [])
                if row["kind"] in PRIMARY_KINDS and row.get("license_mode") == "full"
                and row["body"].strip()
                and (
                    row["work_id"] in outlined
                    or row["work_id"] in searched_primary_works
                    or is_range_read
                )
            )
        elif argv[0] == "stats":
            gaps.update(payload.get("known_gaps", []))
    return counts, issues, primary, gaps


def verify_answer(question, result, docs, works, id_patterns):
    gap_id = question.get("gap_work_id")
    answer = result.get("answer")
    issues = []
    if not isinstance(answer, str) or not answer.strip():
        issues.append("缺少完整回答")
        answer = ""
    commands = result.get("commands")
    if not isinstance(commands, list) or not commands:
        issues.append("缺少逐条命令记录")
        commands = []
    counts, command_issues, primary, gaps = verify_commands(commands, gap_id, docs, works)
    issues.extend(command_issues)

    gap = result.get("known_gap")
    gap_ok = (
        gap_id is not None and gap_id not in works
        and isinstance(gap, str) and gap in gaps and gap_id in gap
        and ("隔离" in gap or "隔離" in gap) and gap_id in answer
        and "stats.known_gaps" in answer
        and any(word in answer.lower() for word in ("隔离", "隔離", "剔除", "quarantin"))
    )
    if gap_id is not None and not gap_ok:
        issues.append(f"缺少 {gap_id} 的真实 stats.known_gaps 隔离证据")

    citations = result.get("citations")
    if not isinstance(citations, list) or (not citations and gap_id is None):
        issues.append("缺少结构化出处")
        citations = []
    declared = {"doc_id": set(), "work_id": set()}
    for citation in citations:
        if not isinstance(citation, dict) or not id_record(citation):
            issues.append("出处须同时提供 doc_id 和 work_id")
            continue
        doc_id, work_id = citation["doc_id"], citation["work_id"]
        declared["doc_id"].add(doc_id)
        declared["work_id"].add(work_id)
        if doc_id not in docs:
            continue
        expected_work, url, time_range = docs[doc_id]
        if expected_work != work_id:
            issues.append(f"出处的 doc_id 和 work_id 不匹配（{doc_id}, {work_id}）")
            continue
        if "origin_url" in citation and citation["origin_url"] != url:
            issues.append(f"出处链接不匹配（{doc_id}）")
        if "time_range" in citation and citation["time_range"] != time_range:
            issues.append(f"出处时间不匹配（{doc_id}）")
        if (doc_id, work_id) in primary:
            counts["primary"] = 1

    citation_text = answer.replace(gap, "") if gap_ok else answer
    for field, valid in (("doc_id", docs), ("work_id", works)):
        explicit = re.findall(
            rf'\b{field}["\x27`*]*\s*[:=：]\s*["\x27`*]*([\w-]+)', citation_text
        )
        mentioned = set(id_patterns[field].findall(citation_text)) | set(explicit) | declared[field]
        if field == "work_id" and gap_ok:
            mentioned.discard(gap_id)
        missing = mentioned.difference(valid)
        counts["ids"] += len(mentioned)
        counts["invalid_ids"] += len(missing)
        if missing:
            issues.append(f"不存在的 {field}（{', '.join(sorted(missing))}）")

    if question["requires_primary"] and not counts["primary"]:
        issues.append("缺少与引用相匹配的一手原文 read 溯源证据")
    valid_urls = {docs[doc_id][1] for doc_id in declared["doc_id"] if doc_id in docs and docs[doc_id][1]}
    mentioned_urls = {
        u.rstrip(".,;:!?。，；：！？)）]\"'`")
        for u in re.findall(r"https?://[^\s)）\]\"'<>`，。；！？]+", citation_text)
    }
    bad_urls = sorted(u for u in mentioned_urls if valid_urls and u not in valid_urls)
    if bad_urls:
        issues.append(f"正文引用链接与已核验出处不一致（{', '.join(bad_urls)}）")
    return {"answer": answer, "citations": citations, "known_gap": gap, "counts": counts,
            "issues": issues}


def table_cell(value):
    return str(value).replace("|", r"\|").replace("\n", " ")


def report(questions, results):
    lines = ["# CLEC Agent 端到端验证", ""]
    if results is None:
        lines += ["**待执行独立盲测。**", ""]
    else:
        total = sum((row["counts"] for row in results.values()), Counter())
        errors = sum(total[key] for key in ("timeout", "capture", "execution", "parse"))
        required = [question for question in questions.values() if question["requires_primary"]]
        covered = sum(results[question["id"]]["counts"]["primary"] for question in required)
        answered = sum(bool(row["answer"]) for row in results.values())
        success = all(not row["issues"] for row in results.values())
        command_rate = f"{errors / total['commands']:.2%}" if total["commands"] else "无记录"
        id_rate = f"{1 - total['invalid_ids'] / total['ids']:.2%}" if total["ids"] else "无记录"
        lines += [
            f"**{'通过' if success else '未通过'}**",
            "",
            f"- 已回答 {answered}/{len(questions)} 题",
            f"- 命令异常 {errors}/{total['commands']}（{command_rate}）。"
            f"异常退出 {total['execution']}，解析异常 {total['parse']}，超时 {total['timeout']}，"
            f"记录无效 {total['capture']}，另有合法缺失退出码 4 共 {total['expected_missing']} 次",
            f"- 语料中存在的引用 ID {total['ids'] - total['invalid_ids']}/{total['ids']}（{id_rate}）",
            f"- 原文题完成一手原文 `read` 溯源且引用对应原文 {covered}/{len(required)}"
            f"（{covered / len(required):.2%}）",
            "",
        ]

    lines += [
        "## 15 题总表",
        "",
        "| 题号 | 问题 | 需溯源 | 命令数 | 合法 4 | 原文证据 | 核验 |",
        "| --- | --- | --- | ---: | ---: | --- | --- |",
    ]
    for qid, question in questions.items():
        row = [qid, question["question"], "是" if question["requires_primary"] else "否"]
        if results is None:
            row += ["—", "—", "—", "待测"]
        else:
            counts = results[qid]["counts"]
            row += [
                counts["commands"],
                counts["expected_missing"],
                "有" if counts["primary"] else "未记录",
                "；".join(results[qid]["issues"]) or "通过",
            ]
        lines.append("| " + " | ".join(map(table_cell, row)) + " |")

    lines += ["", "## 五份完整问答样本"]
    for qid, question in questions.items():
        if not question.get("sample"):
            continue
        lines += ["", f"### {qid}", "", question["question"], ""]
        if results is None or not results[qid]["answer"]:
            lines.append("待录入。")
            continue
        result = results[qid]
        lines.append(result["answer"])
        if result["citations"] or result["known_gap"]:
            evidence = {"citations": result["citations"]}
            if result["known_gap"]:
                evidence["stats.known_gaps"] = result["known_gap"]
            lines += ["", "~~~json", json.dumps(evidence, ensure_ascii=False, indent=2), "~~~"]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--results", type=Path, help="captured blind-run JSON")
    mode.add_argument("--template", action="store_true", help="render the pending report")
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--report", type=Path, default=HERE / "agent-e2e-report.md")
    args = parser.parse_args()

    try:
        questions = unique_by_id(
            json.loads((HERE / "agent_e2e_questions.json").read_text(encoding="utf-8")),
            "question",
        )
        results = None
        if args.results:
            submitted = unique_by_id(json.loads(args.results.read_text(encoding="utf-8")), "result")
            unknown = submitted.keys() - questions.keys()
            if unknown:
                raise ValueError(f"unexpected result IDs: {', '.join(sorted(unknown))}")
            docs, works = load_corpus(args.corpus)
            # Check IDs embedded in prose. Other work prefixes can occur in
            # ordinary words such as "post-retirement", so require code quoting.
            prefixes = {work.split("-", 1)[0] for work in works}
            other_prefixes = "|".join(map(re.escape, sorted(prefixes - {"ep", "short"})))
            id_patterns = {
                "doc_id": re.compile(r"(?<![A-Za-z0-9_-])(p_[\w-]+_\d{4})(?![A-Za-z0-9_-])"),
                "work_id": re.compile(
                    rf"(?:`(?=(?:{other_prefixes})-)|(?<![A-Za-z0-9_-])(?=(?:ep|short)-[0-9]))"
                    rf"((?:ep|short)-[0-9]+[A-Za-z]*|(?:{other_prefixes})-[\w-]+)"
                    r"(?![A-Za-z0-9_-])"
                ),
            }
            results = {
                qid: verify_answer(question, submitted.get(qid, {}), docs, works, id_patterns)
                for qid, question in questions.items()
            }
        args.report.write_text(report(questions, results), encoding="utf-8")
    except (KeyError, OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(args.report)
    return int(results is not None and any(row["issues"] for row in results.values()))


if __name__ == "__main__":
    sys.exit(main())
