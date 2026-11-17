"""Pure Phase 3 dataset validation, canonical alias resolution, and evidence scoring."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Any


VALID_SPLITS = frozenset({"development", "evaluation"})
VALID_EVIDENCE_KINDS = frozenset({"required", "counterexample", "condition"})
MD_TS_RE = re.compile(r"^## \[\d+:\d{2}:\d{2}[.,]\d{3}\s+[–-]\s+\d+:\d{2}:\d{2}[.,]\d{3}\]$")


def merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def intervals_cover(covering: list[tuple[int, int]], target: tuple[int, int]) -> bool:
    t_start, t_end = target
    if t_start >= t_end:
        return False
    cursor = t_start
    for start, end in merge_intervals(covering):
        if start > cursor:
            return False
        cursor = max(cursor, end)
        if cursor >= t_end:
            return True
    return False


def _project_source_word_spans(raw_bytes: bytes, path: str, cues: list[tuple[int, int]]) -> list[tuple[int, int, str]]:
    text = raw_bytes.decode("utf-8")
    ext = Path(path).suffix.lower()
    regions: list[tuple[int, int]] = []
    if ext in (".srt", ".str", ".vtt") and cues:
        regions = cues
    elif ext == ".md" and text.lstrip("\ufeff").startswith("# 語音筆記："):
        pos = 0
        first_line = True
        for line in text.splitlines(keepends=True):
            stripped = line.lstrip("\ufeff").strip()
            line_start = pos
            pos += len(line.encode("utf-8"))
            if first_line:
                first_line = False
                continue
            if not stripped or MD_TS_RE.match(stripped):
                continue
            regions.append((line_start, pos))
        if not regions:
            regions = [(3 if raw_bytes.startswith(b"\xef\xbb\xbf") else 0, len(raw_bytes))]
    else:
        start_off = 3 if raw_bytes.startswith(b"\xef\xbb\xbf") else 0
        regions = [(start_off, len(raw_bytes))]

    word_spans: list[tuple[int, int, str]] = []
    for reg_start, reg_end in regions:
        region_str = raw_bytes[reg_start:reg_end].decode("utf-8")
        cur_byte = reg_start
        for m in re.finditer(r"\S+", region_str):
            prefix_bytes = len(region_str[: m.start()].encode("utf-8"))
            tok_bytes = len(m.group(0).encode("utf-8"))
            w_start = cur_byte + prefix_bytes
            w_end = w_start + tok_bytes
            word_spans.append((w_start, w_end, m.group(0)))
    return word_spans


def _byte_spans_to_word_indices(
    word_spans: list[tuple[int, int, str]],
    byte_spans: list[tuple[int, int]],
) -> list[tuple[int, int]]:
    covered_indices: list[tuple[int, int]] = []
    for b_start, b_end in byte_spans:
        first_idx: int | None = None
        last_idx: int | None = None
        for idx, (w_start, w_end, _) in enumerate(word_spans):
            if w_end > b_start and w_start < b_end:
                if first_idx is None:
                    first_idx = idx
                last_idx = idx + 1
        if first_idx is not None and last_idx is not None:
            covered_indices.append((first_idx, last_idx))
    return merge_intervals(covered_indices)


class CorpusIndexView:
    """Read-only view of an active clec-native-v2 SQLite corpus for ground-truth validation."""

    def __init__(self, db_path: Path, expected_sha256: str) -> None:
        self.db_path = db_path
        self.expected_sha256 = expected_sha256
        self.works_by_key: dict[str, str] = {}
        self.sources: dict[str, dict[str, Any]] = {}
        self.blobs: dict[str, bytes] = {}
        self.cues_by_source: dict[str, list[tuple[int, int]]] = {}
        self._word_spans_cache: dict[str, list[tuple[int, int, str]]] = {}
        self._load()

    def _load(self) -> None:
        with sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True) as conn:
            fmt = conn.execute("SELECT value FROM metadata WHERE key='corpus_format'").fetchone()
            if not fmt or fmt[0] != "clec-native-v2":
                raise ValueError(f"Expected clec-native-v2 database, got {fmt}")
            for wid, wkey in conn.execute("SELECT id, work_key FROM works"):
                self.works_by_key[wkey] = wid
            for (
                sid,
                wid,
                path,
                role,
                chash,
                canon_sid,
                eq_hash,
                proj_kind,
            ) in conn.execute(
                "SELECT s.id, s.work_id, s.path, s.role, s.content_hash, "
                "m.canonical_source_id, m.equivalence_hash, m.projection_kind "
                "FROM sources s JOIN source_canonical_map m ON m.source_id = s.id"
            ):
                self.sources[sid] = {
                    "sourceId": sid,
                    "workId": wid,
                    "path": path,
                    "role": role,
                    "contentHash": chash,
                    "canonicalSourceId": canon_sid,
                    "equivalenceHash": eq_hash,
                    "projectionKind": proj_kind,
                }
            for chash, raw_bytes in conn.execute("SELECT content_hash, raw_bytes FROM blobs"):
                self.blobs[chash] = bytes(raw_bytes)
            for sid, ts, te in conn.execute(
                "SELECT source_id, text_start_byte, text_end_byte FROM cues ORDER BY source_id, ordinal"
            ):
                self.cues_by_source.setdefault(sid, []).append((int(ts), int(te)))

    def raw_bytes_for_source(self, source_id: str) -> bytes:
        src = self.sources[source_id]
        return self.blobs[src["contentHash"]]

    def word_spans_for_source(self, source_id: str) -> list[tuple[int, int, str]]:
        if source_id not in self._word_spans_cache:
            src = self.sources[source_id]
            raw = self.blobs[src["contentHash"]]
            cues = self.cues_by_source.get(source_id, [])
            self._word_spans_cache[source_id] = _project_source_word_spans(raw, src["path"], cues)
        return self._word_spans_cache[source_id]

    def are_canonical_aliases(self, source_a: str, source_b: str) -> bool:
        sa = self.sources.get(source_a)
        sb = self.sources.get(source_b)
        if sa is None or sb is None:
            return False
        return (
            sa["canonicalSourceId"] == sb["canonicalSourceId"]
            and sa["workId"] == sb["workId"]
            and sa["role"] == sb["role"]
            and sa["equivalenceHash"] == sb["equivalenceHash"]
        )


def validate_dataset_against_db(
    dataset: dict[str, Any],
    corpus: CorpusIndexView,
    active_release_sha256: str,
) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    if not isinstance(dataset, dict) or dataset.get("schemaVersion") != 1:
        errors.append({"field": "schemaVersion", "error": "Expected schemaVersion == 1"})
        return errors
    ds_sha = dataset.get("corpusSha256")
    if ds_sha != active_release_sha256:
        errors.append(
            {
                "field": "corpusSha256",
                "error": f"Dataset corpusSha256 {ds_sha!r} != active release {active_release_sha256!r}",
            }
        )
    if dataset.get("split") not in VALID_SPLITS:
        errors.append({"field": "split", "error": f"Invalid split {dataset.get('split')!r}"})

    questions = dataset.get("questions")
    if not isinstance(questions, list) or not questions:
        errors.append({"field": "questions", "error": "Dataset must have a non-empty questions list"})
        return errors

    seen_qids: set[str] = set()
    for q in questions:
        qid = q.get("id")
        if not isinstance(qid, str) or not qid or qid in seen_qids:
            errors.append({"questionId": qid, "error": "Missing or duplicate question id"})
            continue
        seen_qids.add(qid)
        if not isinstance(q.get("question"), str) or not q["question"].strip():
            errors.append({"questionId": qid, "error": "Empty question text"})
        if not isinstance(q.get("answerable"), bool):
            errors.append({"questionId": qid, "error": "answerable must be boolean"})
        work_keys = q.get("workKeys")
        if not isinstance(work_keys, list):
            errors.append({"questionId": qid, "error": "workKeys must be a list"})
            work_keys = []
        allowed_work_ids: set[str] = set()
        for wk in work_keys:
            if wk not in corpus.works_by_key:
                errors.append({"questionId": qid, "workKey": wk, "error": "Unknown workKey in corpus"})
            else:
                allowed_work_ids.add(corpus.works_by_key[wk])

        evidence = q.get("evidence")
        if not isinstance(evidence, list):
            errors.append({"questionId": qid, "error": "evidence must be a list"})
            continue
        if q.get("answerable") is True and not evidence:
            errors.append({"questionId": qid, "error": "answerable=true question has empty evidence"})

        for idx, ev in enumerate(evidence):
            cid = ev.get("claimId")
            sid = ev.get("sourceId")
            path = ev.get("path")
            kind = ev.get("kind")
            quote = ev.get("quote")
            spans = ev.get("spans")
            if not isinstance(cid, str) or not cid:
                errors.append({"questionId": qid, "evidenceIndex": idx, "error": "Missing claimId"})
            if kind not in VALID_EVIDENCE_KINDS:
                errors.append({"questionId": qid, "evidenceIndex": idx, "error": f"Invalid kind {kind!r}"})
            if sid not in corpus.sources:
                errors.append({"questionId": qid, "evidenceIndex": idx, "sourceId": sid, "error": "Unknown sourceId"})
                continue
            src_meta = corpus.sources[sid]
            if path != src_meta["path"]:
                errors.append(
                    {
                        "questionId": qid,
                        "evidenceIndex": idx,
                        "sourceId": sid,
                        "error": f"Path mismatch: annotation {path!r} != DB {src_meta['path']!r}",
                    }
                )
            if allowed_work_ids and src_meta["workId"] not in allowed_work_ids:
                errors.append(
                    {
                        "questionId": qid,
                        "evidenceIndex": idx,
                        "sourceId": sid,
                        "error": "Source workId is outside question workKeys",
                    }
                )
            if not isinstance(spans, list) or not spans:
                errors.append({"questionId": qid, "evidenceIndex": idx, "error": "Missing spans"})
                continue
            raw = corpus.raw_bytes_for_source(sid)
            parts: list[str] = []
            span_ok = True
            for sp in spans:
                sb = sp.get("startByte")
                eb = sp.get("endByte")
                if not isinstance(sb, int) or not isinstance(eb, int) or sb < 0 or sb >= eb or eb > len(raw):
                    errors.append(
                        {
                            "questionId": qid,
                            "evidenceIndex": idx,
                            "span": sp,
                            "error": "Invalid UTF-8 byte span range",
                        }
                    )
                    span_ok = False
                    break
                try:
                    parts.append(raw[sb:eb].decode("utf-8"))
                except UnicodeDecodeError:
                    errors.append(
                        {
                            "questionId": qid,
                            "evidenceIndex": idx,
                            "span": sp,
                            "error": "Span does not fall on valid UTF-8 boundaries",
                        }
                    )
                    span_ok = False
                    break
            if span_ok and "\n".join(parts) != quote:
                errors.append(
                    {
                        "questionId": qid,
                        "evidenceIndex": idx,
                        "error": "Gold quote does not equal UTF-8 slice from blobs.raw_bytes",
                    }
                )
    return errors


def verify_returned_citation_spans(
    items: list[dict[str, Any]],
    corpus: CorpusIndexView,
) -> list[dict[str, Any]]:
    """Audit every returned hit/read item against raw source bytes in SQLite."""
    failures: list[dict[str, Any]] = []
    for idx, item in enumerate(items):
        source_obj = item.get("source") or {}
        sid = source_obj.get("sourceId")
        if sid not in corpus.sources:
            failures.append({"itemIndex": idx, "sourceId": sid, "error": "Unknown sourceId in CLI output"})
            continue
        raw = corpus.raw_bytes_for_source(sid)
        src_meta = corpus.sources[sid]
        if hashlib.sha256(raw).hexdigest() != src_meta["contentHash"]:
            failures.append({"itemIndex": idx, "sourceId": sid, "error": "Blob SHA-256 mismatch"})
            continue
        if item.get("kind") == "sourceOriginal" or "originalText" in item:
            if item.get("originalText") != raw.decode("utf-8"):
                failures.append({"itemIndex": idx, "sourceId": sid, "error": "originalText does not match raw bytes"})
            continue
        spans = item.get("spans")
        text = item.get("text")
        if not isinstance(spans, list) or not spans or not isinstance(text, str):
            failures.append({"itemIndex": idx, "sourceId": sid, "error": "Missing spans or text"})
            continue
        reconstructed_parts: list[str] = []
        valid = True
        for sp in spans:
            sb = sp.get("startByte")
            eb = sp.get("endByte")
            if not isinstance(sb, int) or not isinstance(eb, int) or sb < 0 or sb >= eb or eb > len(raw):
                failures.append({"itemIndex": idx, "sourceId": sid, "span": sp, "error": "Span out of raw_bytes bounds"})
                valid = False
                break
            try:
                reconstructed_parts.append(raw[sb:eb].decode("utf-8"))
            except UnicodeDecodeError:
                failures.append({"itemIndex": idx, "sourceId": sid, "span": sp, "error": "Span splits UTF-8 codepoint"})
                valid = False
                break
        if valid and "\n".join(reconstructed_parts) != text:
            failures.append({"itemIndex": idx, "sourceId": sid, "error": "Returned text differs from raw_bytes[spans]"})
        for c_idx, ctx in enumerate(item.get("context") or []):
            ctx_spans = ctx.get("spans")
            ctx_text = ctx.get("text")
            if not isinstance(ctx_spans, list) or not ctx_spans or not isinstance(ctx_text, str):
                failures.append({"itemIndex": idx, "contextIndex": c_idx, "sourceId": sid, "error": "Missing context spans or text"})
                continue
            ctx_parts: list[str] = []
            ctx_ok = True
            for sp in ctx_spans:
                sb = sp.get("startByte")
                eb = sp.get("endByte")
                if not isinstance(sb, int) or not isinstance(eb, int) or sb < 0 or sb >= eb or eb > len(raw):
                    failures.append({"itemIndex": idx, "contextIndex": c_idx, "sourceId": sid, "span": sp, "error": "Context span out of bounds"})
                    ctx_ok = False
                    break
                try:
                    ctx_parts.append(raw[sb:eb].decode("utf-8"))
                except UnicodeDecodeError:
                    failures.append({"itemIndex": idx, "contextIndex": c_idx, "sourceId": sid, "span": sp, "error": "Context span splits UTF-8 codepoint"})
                    ctx_ok = False
                    break
            if ctx_ok and "\n".join(ctx_parts) != ctx_text:
                failures.append({"itemIndex": idx, "contextIndex": c_idx, "sourceId": sid, "error": "Context text differs from raw_bytes[spans]"})
    return failures


def _item_covers_evidence(
    ev: dict[str, Any],
    items: list[dict[str, Any]],
    corpus: CorpusIndexView,
) -> bool:
    gold_sid = ev["sourceId"]
    gold_spans = [(int(sp["startByte"]), int(sp["endByte"])) for sp in ev["spans"]]

    direct_spans: list[tuple[int, int]] = []
    for item in items:
        item_sid = (item.get("source") or {}).get("sourceId")
        if item_sid != gold_sid:
            continue
        if item.get("kind") == "sourceOriginal" or "originalText" in item:
            raw_len = len(corpus.raw_bytes_for_source(gold_sid))
            direct_spans.append((0, raw_len))
        else:
            for sp in item.get("spans", []):
                direct_spans.append((int(sp["startByte"]), int(sp["endByte"])))
            for ctx in item.get("context") or []:
                for sp in ctx.get("spans", []):
                    direct_spans.append((int(sp["startByte"]), int(sp["endByte"])))

    if direct_spans and all(intervals_cover(direct_spans, gs) for gs in gold_spans):
        return True

    # Canonical alias proof via source_canonical_map (never naive filename matching).
    gold_word_spans = corpus.word_spans_for_source(gold_sid)
    gold_word_intervals = _byte_spans_to_word_indices(gold_word_spans, gold_spans)
    if not gold_word_intervals:
        return False

    alias_word_intervals: list[tuple[int, int]] = []
    for item in items:
        item_sid = (item.get("source") or {}).get("sourceId")
        if not item_sid or item_sid == gold_sid:
            continue
        if not corpus.are_canonical_aliases(gold_sid, item_sid):
            continue
        item_word_spans = corpus.word_spans_for_source(item_sid)
        if item.get("kind") == "sourceOriginal" or "originalText" in item:
            item_byte_spans = [(0, len(corpus.raw_bytes_for_source(item_sid)))]
        else:
            item_byte_spans = [(int(sp["startByte"]), int(sp["endByte"])) for sp in item.get("spans", [])]
            for ctx in item.get("context") or []:
                item_byte_spans.extend(
                    (int(sp["startByte"]), int(sp["endByte"])) for sp in ctx.get("spans", [])
                )
        alias_word_intervals.extend(_byte_spans_to_word_indices(item_word_spans, item_byte_spans))

    return bool(alias_word_intervals) and all(
        intervals_cover(alias_word_intervals, gwi) for gwi in gold_word_intervals
    )


def select_items_within_utf8_budget(
    items: list[dict[str, Any]],
    utf8_byte_budget: int | None,
) -> tuple[list[dict[str, Any]], int]:
    """Accumulate items in order, stopping at the first item exceeding the serialized UTF-8 byte budget."""
    selected: list[dict[str, Any]] = []
    used = 0
    for item in items:
        item_bytes = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        if utf8_byte_budget is not None and used + item_bytes > utf8_byte_budget:
            break
        selected.append(item)
        used += item_bytes
    return selected, used


def _build_obligations(evidence: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group evidence items: items sharing (claimId, alternativeGroup) are alternatives; otherwise AND."""
    alt_groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    obligations: list[list[dict[str, Any]]] = []
    for ev in evidence:
        alt_group = ev.get("alternativeGroup")
        if isinstance(alt_group, str) and alt_group:
            key = (ev["claimId"], alt_group)
            if key not in alt_groups:
                group_list: list[dict[str, Any]] = []
                alt_groups[key] = group_list
                obligations.append(group_list)
            alt_groups[key].append(ev)
        else:
            obligations.append([ev])
    return obligations


def score_question(
    question: dict[str, Any],
    outcome: dict[str, Any],
    corpus: CorpusIndexView,
    *,
    top_k: int = 5,
    stdout_byte_budget: int | None = None,
    read_byte_budget: int | None = None,
) -> dict[str, Any]:
    status = outcome.get("status", "error")
    stop_reason = outcome.get("stopReason")
    raw_hits = list(outcome.get("hits") or [])[:top_k]
    raw_reads = list(outcome.get("reads") or [])

    selected_hits, hits_utf8_bytes = select_items_within_utf8_budget(raw_hits, stdout_byte_budget)
    selected_reads, reads_utf8_bytes = select_items_within_utf8_budget(raw_reads, read_byte_budget)
    selected_all = selected_hits + selected_reads

    citation_failures = verify_returned_citation_spans(selected_all, corpus)

    if status != "completed":
        return {
            "id": question["id"],
            "category": question.get("category"),
            "answerable": question["answerable"],
            "status": status,
            "stopReason": stop_reason or status,
            "topK": top_k,
            "stdoutByteBudget": stdout_byte_budget,
            "readByteBudget": read_byte_budget,
            "serializedHitsUtf8Bytes": hits_utf8_bytes,
            "serializedReadsUtf8Bytes": reads_utf8_bytes,
            "tokenBudget": None,
            "tokenMetricNote": "UTF-8 bytes are not tokens; token budget requires model tokenizer",
            "citationRawSpanValid": len(citation_failures) == 0,
            "citationFailures": citation_failures,
            "obligationCount": len(_build_obligations(question.get("evidence", []))),
            "coveredObligations": None,
            "evidenceCoverage": None,
            "completeChain": None,
            "conditionCount": sum(1 for ev in question.get("evidence", []) if ev.get("kind") == "condition"),
            "conditionsCovered": None,
            "conditionLoss": None,
            "counterexampleCount": sum(1 for ev in question.get("evidence", []) if ev.get("kind") == "counterexample"),
            "counterexamplesCovered": None,
            "counterexampleLoss": None,
        }

    if question["answerable"] is False:
        return {
            "id": question["id"],
            "category": question.get("category"),
            "answerable": False,
            "status": "completed",
            "stopReason": None,
            "topK": top_k,
            "stdoutByteBudget": stdout_byte_budget,
            "readByteBudget": read_byte_budget,
            "serializedHitsUtf8Bytes": hits_utf8_bytes,
            "serializedReadsUtf8Bytes": reads_utf8_bytes,
            "tokenBudget": None,
            "tokenMetricNote": "UTF-8 bytes are not tokens; token budget requires model tokenizer",
            "citationRawSpanValid": len(citation_failures) == 0,
            "citationFailures": citation_failures,
            "returnedHitCount": len(selected_hits),
            "evidenceCoverage": None,
            "completeChain": None,
            "unanswerableNote": "Irrelevant retrieval on unanswerable question is expected; insufficiency marking requires host eval.",
        }

    evidence = question.get("evidence", [])
    obligations = _build_obligations(evidence)
    covered_obs = 0
    for ob_group in obligations:
        if any(_item_covers_evidence(ev, selected_all, corpus) for ev in ob_group):
            covered_obs += 1

    cond_obs = [ob for ob in obligations if any(ev.get("kind") == "condition" for ev in ob)]
    cond_cov = sum(1 for ob in cond_obs if any(_item_covers_evidence(ev, selected_all, corpus) for ev in ob))
    ce_obs = [ob for ob in obligations if any(ev.get("kind") == "counterexample" for ev in ob)]
    ce_cov = sum(1 for ob in ce_obs if any(_item_covers_evidence(ev, selected_all, corpus) for ev in ob))

    citation_ok = len(citation_failures) == 0
    complete_chain = bool(obligations) and covered_obs == len(obligations) and citation_ok
    coverage = (covered_obs / len(obligations)) if obligations else None

    return {
        "id": question["id"],
        "category": question.get("category"),
        "answerable": True,
        "status": "completed",
        "stopReason": None,
        "topK": top_k,
        "stdoutByteBudget": stdout_byte_budget,
        "readByteBudget": read_byte_budget,
        "serializedHitsUtf8Bytes": hits_utf8_bytes,
        "serializedReadsUtf8Bytes": reads_utf8_bytes,
        "tokenBudget": None,
        "tokenMetricNote": "UTF-8 bytes are not tokens; token budget requires model tokenizer",
        "citationRawSpanValid": citation_ok,
        "citationFailures": citation_failures,
        "obligationCount": len(obligations),
        "coveredObligations": covered_obs,
        "evidenceCoverage": coverage,
        "completeChain": complete_chain,
        "conditionCount": len(cond_obs),
        "conditionsCovered": cond_cov,
        "conditionLoss": len(cond_obs) - cond_cov,
        "counterexampleCount": len(ce_obs),
        "counterexamplesCovered": ce_cov,
        "counterexampleLoss": len(ce_obs) - ce_cov,
    }


def summarize_evaluation(
    dataset: dict[str, Any],
    outcomes: list[dict[str, Any]],
    corpus: CorpusIndexView,
    active_release_sha256: str,
    *,
    top_k: int = 5,
    stdout_byte_budget: int | None = 65_536,
    read_byte_budget: int | None = None,
) -> dict[str, Any]:
    gt_errors = validate_dataset_against_db(dataset, corpus, active_release_sha256)
    if gt_errors:
        return {
            "schemaVersion": 1,
            "verdict": "inconclusive",
            "reason": "Ground truth validation failed or dataset corpusSha256 mismatched active corpus.",
            "groundTruthValidation": {"valid": False, "errorCount": len(gt_errors), "errors": gt_errors},
            "corpusSha256": active_release_sha256,
            "split": dataset.get("split"),
            "perQuestion": [],
        }

    questions = dataset["questions"]
    outcomes_by_id = {o["id"]: o for o in outcomes}
    per_question: list[dict[str, Any]] = []
    for q in questions:
        outcome = outcomes_by_id.get(
            q["id"],
            {"id": q["id"], "status": "error", "stopReason": "missing_outcome", "hits": [], "reads": []},
        )
        per_question.append(
            score_question(
                q,
                outcome,
                corpus,
                top_k=top_k,
                stdout_byte_budget=stdout_byte_budget,
                read_byte_budget=read_byte_budget,
            )
        )

    answerable_rows = [r for r in per_question if r["answerable"] is True]
    completed_answerable = [r for r in answerable_rows if r["status"] == "completed"]
    unanswerable_rows = [r for r in per_question if r["answerable"] is False]
    error_rows = [r for r in per_question if r["status"] != "completed"]

    complete_chains = sum(1 for r in completed_answerable if r["completeChain"] is True)
    mean_coverage_completed = (
        sum(r["evidenceCoverage"] for r in completed_answerable if r["evidenceCoverage"] is not None)
        / len(completed_answerable)
        if completed_answerable
        else None
    )
    citation_valid_count = sum(1 for r in per_question if r["citationRawSpanValid"] is True)
    total_conditions = sum(r.get("conditionCount", 0) for r in answerable_rows)
    total_conditions_covered = sum(r.get("conditionsCovered") or 0 for r in completed_answerable)
    total_counterexamples = sum(r.get("counterexampleCount", 0) for r in answerable_rows)
    total_counterexamples_covered = sum(r.get("counterexamplesCovered") or 0 for r in completed_answerable)

    gates = {
        "groundTruthValid": True,
        "zeroRawQuoteFabricationOrWrongRange": citation_valid_count == len(per_question),
        "zeroErrorsInDenominator": len(error_rows) == 0,
        "zeroCriticalConditionLoss": total_conditions == total_conditions_covered
        and total_counterexamples == total_counterexamples_covered,
    }

    return {
        "schemaVersion": 1,
        "verdict": "complete" if len(error_rows) == 0 else "inconclusive_errors_present",
        "groundTruthValidation": {"valid": True, "errorCount": 0, "errors": []},
        "corpusSha256": active_release_sha256,
        "split": dataset["split"],
        "topK": top_k,
        "stdoutByteBudget": stdout_byte_budget,
        "readByteBudget": read_byte_budget,
        "counts": {
            "scheduledQuestions": len(per_question),
            "answerableQuestions": len(answerable_rows),
            "unanswerableQuestions": len(unanswerable_rows),
            "completedAnswerable": len(completed_answerable),
            "errorsOrTimeouts": len(error_rows),
            "completeChains": complete_chains,
            "completeChainRateAllScheduledAnswerable": (
                complete_chains / len(answerable_rows) if answerable_rows else None
            ),
            "meanEvidenceCoverageCompletedAnswerable": mean_coverage_completed,
            "citationRawSpanValidCount": citation_valid_count,
            "conditionsTotal": total_conditions,
            "conditionsCovered": total_conditions_covered,
            "conditionLosses": total_conditions - total_conditions_covered,
            "counterexamplesTotal": total_counterexamples,
            "counterexamplesCovered": total_counterexamples_covered,
            "counterexampleLosses": total_counterexamples - total_counterexamples_covered,
        },
        "gates": gates,
        "perQuestion": per_question,
    }
