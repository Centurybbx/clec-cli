#!/usr/bin/env python3
"""Deterministic Phase 2 intake and reconciliation builder for the CLEC corpus."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any
from urllib.parse import urlparse

DATE_PATTERN = re.compile(
    r"(?<!\d)((?:19|20)\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})(?:\s*[日號])?(?!\d)"
)
FRONTMATTER_RE = re.compile(r"^\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)")
MD_TS_RE = re.compile(r"^## \[\d+:\d{2}:\d{2}[.,]\d{3}\s+[–-]\s+\d+:\d{2}:\d{2}[.,]\d{3}\]$")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def is_valid_ymd(date_str: str) -> bool:
    try:
        dt.date.fromisoformat(date_str)
        return True
    except ValueError:
        return False


def extract_source_date(title: str, record: dict[str, Any] | None = None) -> tuple[str | None, str | None]:
    if record:
        declared = record.get("date")
        if isinstance(declared, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", declared) and is_valid_ymd(declared):
            basis = record.get("dateBasis") or record.get("date_basis") or "declared_manifest_date"
            return declared, str(basis)
    found: set[str] = set()
    for m in DATE_PATTERN.finditer(title):
        candidate = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        if is_valid_ymd(candidate):
            found.add(candidate)
    if len(found) == 1:
        return next(iter(found)), "source_title"
    return None, None


def is_quarantined_value(val: Any) -> bool:
    return isinstance(val, str) and bool(re.search(r"quarantin|do_not_use|suspected_hallucination", val, re.I))


def load_json_array(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Expected JSON array in {path}")
    return [row for row in data if isinstance(row, dict)]


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            obj = json.loads(line)
            if isinstance(obj, dict):
                rows.append(obj)
    return rows


def fold_ws(text: str) -> str:
    return " ".join(text.split())


def project_body_for_candidate_audit(path: Path, rel_path: str) -> str:
    text = path.read_text(encoding="utf-8")
    ext = path.suffix.lower()
    if ext in (".srt", ".str", ".vtt"):
        lines = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
        parts: list[str] = []
        i = 0
        while i < len(lines):
            if "-->" in lines[i]:
                i += 1
                cue: list[str] = []
                while i < len(lines) and lines[i].strip() != "" and "-->" not in lines[i]:
                    cue.append(lines[i])
                    i += 1
                if cue:
                    parts.append("\n".join(cue))
            else:
                i += 1
        return fold_ws("\n".join(parts))
    if ext == ".md":
        lines = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if lines and lines[0].startswith("# 語音筆記："):
            body_lines = [l for l in lines[1:] if not MD_TS_RE.match(l.strip())]
            return fold_ws("\n".join(body_lines))
    if rel_path.startswith("collection/sources/drive/text/"):
        parts = text.split("\n\n", 1)
        if len(parts) == 2 and parts[0].startswith("来源:"):
            return fold_ws(parts[1])
    return fold_ws(text.lstrip("\ufeff"))


def read_title_from_saved_body(path: Path, fallback: str) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return fallback
    lines = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if re.match(r"^(?:来源|來源|采集时间|採集時間)\s*[:：]", s):
            continue
        if re.match(r"^\[[\w-]+\]$", s):
            continue
        lines.append(s)
    if not lines:
        return fallback
    first = lines[0]
    if re.match(r"^\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}$", first) and len(lines) > 1:
        return " ".join(lines[:2])[:1000]
    return first[:1000]


def prepare_intake(workspace: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    works: dict[str, str] = {}
    candidates_by_path: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    non_evidence_items: dict[str, dict[str, Any]] = {}

    def ensure_work(work_key: str, title: str) -> None:
        clean_title = title.strip() or work_key
        if work_key not in works:
            works[work_key] = clean_title

    def add_source(
        *,
        priority_key: str,
        work_key: str,
        work_title: str,
        path: str,
        title: str,
        role: str,
        attribution: str,
        quality: str,
        status: str,
        status_reason: str | None = None,
        date: str | None = None,
        date_basis: str | None = None,
        origin: str | None = None,
        expected_sha256: str | None = None,
    ) -> None:
        ensure_work(work_key, work_title)
        entry: dict[str, Any] = {
            "_priority": priority_key,
            "work": work_key,
            "path": path,
            "title": title.strip() or path,
            "role": role,
            "attribution": attribution,
            "quality": quality,
            "status": status,
        }
        if status_reason:
            entry["statusReason"] = status_reason
        if date and date_basis:
            entry["date"] = date
            entry["dateBasis"] = date_basis
        if origin:
            entry["origin"] = origin
        if expected_sha256:
            entry["_expected_sha256"] = expected_sha256
        candidates_by_path[path].append(entry)

    def add_inventory_only(path: str, work_key: str, work_title: str, status: str, reason: str, role: str = "document") -> None:
        ensure_work(work_key, work_title)
        non_evidence_items[path] = {
            "work": work_key,
            "path": path,
            "title": Path(path).name or path,
            "role": role,
            "attribution": "original_unknown",
            "quality": "collection_metadata_not_evidence",
            "status": status,
            "statusReason": reason,
        }

    for manifest_name, quality in (
        ("manifest.json", "original_document_text_extract_unverified"),
        ("spreadsheets-manifest.json", "spreadsheet_cell_extract_unverified"),
    ):
        mf = f"collection/text/local/{manifest_name}"
        add_inventory_only(mf, f"meta:{mf}", mf, "metadata_only", "metadata_asset")
        for idx, row in enumerate(load_json_array(workspace / mf), start=1):
            orig = str(row["source"])
            work_key = f"local:{orig}"
            orig_title = Path(orig).name or orig
            add_inventory_only(
                orig,
                work_key,
                orig_title,
                "unsupported",
                "original_asset_requires_extraction_or_uses_separate_extract",
            )
            text_rel = row.get("text")
            if isinstance(text_rel, str) and text_rel:
                d, db = extract_source_date(orig_title, row)
                add_source(
                    priority_key=f"01:{mf}:{idx:06d}",
                    work_key=work_key,
                    work_title=orig_title,
                    path=text_rel,
                    title=orig_title,
                    role="document",
                    attribution="original_unknown",
                    quality=quality,
                    status="quarantined" if is_quarantined_value(row.get("status")) else "ready",
                    status_reason="quarantine_do_not_use" if is_quarantined_value(row.get("status")) else None,
                    date=d,
                    date_basis=db,
                    origin=orig,
                )

    for manifest_name in ("text-manifest.json", "nested-text-manifest.json", "deep-text-manifest.json"):
        mf = f"collection/sources/drive/{manifest_name}"
        add_inventory_only(mf, f"meta:{mf}", mf, "metadata_only", "metadata_asset")
        for idx, row in enumerate(load_json_array(workspace / mf), start=1):
            drive_id = str(row["id"])
            title = str(row["title"])
            url = str(row["url"])
            rel = row.get("path")
            if not isinstance(rel, str) or not rel:
                continue
            work_key = f"drive:{drive_id}"
            quality = (
                "drive_text_extract_origin_quality_unverified"
                if re.search(r"\.(md|srt|str|txt)$", title, re.I)
                else "original_document_text_extract_unverified"
            )
            d, db = extract_source_date(title, row)
            add_source(
                priority_key=f"02:{mf}:{idx:06d}",
                work_key=work_key,
                work_title=title,
                path=rel,
                title=title,
                role="document",
                attribution="original_unknown",
                quality=quality,
                status="quarantined" if is_quarantined_value(row.get("status")) else "ready",
                status_reason="quarantine_do_not_use" if is_quarantined_value(row.get("status")) else None,
                date=d,
                date_basis=db,
                origin=url,
            )

    arch_mf = "collection/sources/drive/archive-transcripts-manifest.jsonl"
    add_inventory_only(arch_mf, f"meta:{arch_mf}", arch_mf, "metadata_only", "metadata_asset")
    for idx, row in enumerate(load_jsonl(workspace / arch_mf), start=1):
        container_id = str(row["id"])
        work_key = f"archive:{container_id}"
        outer_name = Path(str(row["outer_member"])).name
        archive_origin = str(row["archive_source"])
        for member in row.get("files", []):
            if not isinstance(member, dict):
                continue
            rel = member.get("path")
            if not isinstance(rel, str) or not rel:
                continue
            title = str(member.get("original_name") or outer_name)
            d, db = extract_source_date(title, row)
            raw_path = workspace / rel
            status = "ready"
            reason = None
            if is_quarantined_value(row.get("status")) or is_quarantined_value(member.get("status")):
                status = "quarantined"
                reason = "quarantine_do_not_use"
            elif not raw_path.is_file():
                status = "missing"
                reason = "file_missing"
            else:
                raw_bytes = raw_path.read_bytes()
                if member.get("sha256") and hashlib.sha256(raw_bytes).hexdigest() != member["sha256"]:
                    raise ValueError(f"Archive hash mismatch on disk for {rel}")
                text = raw_bytes.decode("utf-8")
                if not text.strip():
                    status = "empty"
                    reason = "empty_text"
                elif not "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")).strip():
                    status = "excluded"
                    reason = "heading_only_text"
            add_source(
                priority_key=f"03:{arch_mf}:{idx:06d}",
                work_key=work_key,
                work_title=outer_name,
                path=rel,
                title=title,
                role="transcript",
                attribution="unverified_transcript",
                quality="archive_probable_asr_unverified_no_verified_speakers",
                status=status,
                status_reason=reason,
                date=d,
                date_basis=db,
                origin=archive_origin,
                expected_sha256=member.get("sha256"),
            )

    ctw_ep_mf = "collection/web/clectw/episode-inventory.jsonl"
    add_inventory_only(ctw_ep_mf, f"meta:{ctw_ep_mf}", ctw_ep_mf, "metadata_only", "metadata_asset")
    ctw_titles: dict[str, str] = {}
    for idx, row in enumerate(load_jsonl(workspace / ctw_ep_mf), start=1):
        url = str(row["url"])
        ep_id = str(row["episode_id"])
        work_key = f"clectw:{ep_id}"
        ep_title = str(row.get("title") or ep_id)
        ctw_titles[url] = ep_title
        tr_rel = row.get("transcript")
        if isinstance(tr_rel, str) and tr_rel:
            d, db = extract_source_date(ep_title, row)
            status = "quarantined" if is_quarantined_value(row.get("status")) or is_quarantined_value(row.get("transcript_status")) else "ready"
            add_source(
                priority_key=f"04:{ctw_ep_mf}:{idx:06d}",
                work_key=work_key,
                work_title=ep_title,
                path=tr_rel,
                title=ep_title,
                role="transcript",
                attribution="automatic_unverified",
                quality="automatic_transcript_unverified_no_verified_timestamps_or_speakers",
                status=status,
                status_reason="quarantine_do_not_use" if status == "quarantined" else None,
                date=d,
                date_basis=db,
                origin=url,
            )

    ctw_audit = "collection/web/clectw/transcript-quality-audit.jsonl"
    add_inventory_only(ctw_audit, f"meta:{ctw_audit}", ctw_audit, "metadata_only", "metadata_asset")
    flagged_clectw: set[str] = set()
    for row in load_jsonl(workspace / ctw_audit):
        st = str(row.get("status") or "")
        if is_quarantined_value(st) or (re.search(r"flagged|review|repetit", st, re.I) and st != "not_flagged_automatically"):
            if isinstance(row.get("file"), str):
                flagged_clectw.add(row["file"])

    for site in ("clectw", "clec168", "cfnavi"):
        mf = f"collection/web/{site}/manifest.jsonl"
        add_inventory_only(mf, f"meta:{mf}", mf, "metadata_only", "metadata_asset")
        for idx, row in enumerate(load_jsonl(workspace / mf), start=1):
            url = str(row["url"])
            parsed = urlparse(url)
            pathname = parsed.path
            ep_match = re.match(r"^/ep/([^/]+)/?$", pathname) if site == "clectw" else None
            is_episode_page = ep_match is not None
            is_listing = (
                (site == "clectw" and not is_episode_page)
                or bool(re.search(r"/(?:page|category)(?:/|$)", pathname))
                or (site == "clec168" and not re.match(r"^/(?:blog|docs|database|video)/.+", pathname))
            )
            is_video = site == "clec168" and pathname.startswith("/video/")

            if is_episode_page and ep_match:
                work_key = f"clectw:{ep_match.group(1)}"
            elif site == "clec168":
                work_key = f"clec168:{pathname.strip('/') or 'root'}"
            elif site == "cfnavi":
                work_key = f"cfnavi:{pathname.strip('/') or 'root'}"
            else:
                work_key = f"{site}:{pathname.strip('/') or 'root'}"

            html_rel = row.get("html")
            if isinstance(html_rel, str) and html_rel:
                add_inventory_only(
                    html_rel,
                    work_key,
                    ctw_titles.get(url) or row.get("title") or url,
                    "metadata_only",
                    "html_preserved_not_admitted_as_text",
                )

            text_rel = row.get("text")
            if not isinstance(text_rel, str) or not text_rel:
                continue

            if is_listing:
                add_inventory_only(text_rel, work_key, url, "metadata_only", "listing_not_evidence_body")
                continue

            title = row.get("title") or (ctw_titles.get(url) if is_episode_page else None)
            if not isinstance(title, str) or not title:
                title = read_title_from_saved_body(workspace / text_rel, url)
            work_title = ctw_titles.get(url) or title

            if is_episode_page:
                role = "summary"
                quality = "mixed_episode_page_ai_summary_navigation_not_verified_speech"
            elif is_video:
                role = "summary"
                quality = "video_introduction_and_comments_not_transcript"
            elif site == "cfnavi":
                role = "summary"
                quality = "third_party_course_summary_unverified"
            else:
                role = "document"
                quality = "website_body_extract_unverified_may_include_comments"

            d, db = extract_source_date(title, row)
            status = "quarantined" if is_quarantined_value(row.get("status")) else "ready"
            add_source(
                priority_key=f"05:{mf}:{idx:06d}",
                work_key=work_key,
                work_title=work_title,
                path=text_rel,
                title=title,
                role=role,
                attribution="original_unknown",
                quality=quality,
                status=status,
                status_reason="quarantine_do_not_use" if status == "quarantined" else None,
                date=d,
                date_basis=db,
                origin=url,
            )

    kb_base = workspace / "collection/sources/clec-md/knowledge"
    for md_path in sorted(kb_base.rglob("*.md")):
        rel_from_kb = md_path.relative_to(kb_base).as_posix()
        rel_ws = md_path.relative_to(workspace).as_posix()
        text = md_path.read_text(encoding="utf-8")
        fm_match = FRONTMATTER_RE.match(text)
        fm = fm_match.group(1) if fm_match else ""
        title_m = re.search(r"^title:\s*([^\r\n]+)$", fm, re.M)
        title = title_m.group(1).strip().strip("'\"") if title_m else md_path.stem
        date_m = re.search(r"^date:\s*['\"]?(\d{4}-\d{2}-\d{2})['\"]?\s*$", fm, re.M)
        declared_date = date_m.group(1) if date_m and is_valid_ymd(date_m.group(1)) else None
        status_m = re.search(r"^status:\s*([^\r\n]+)$", fm, re.M)
        declared_status = status_m.group(1).strip().strip("'\"") if status_m else None

        is_qa = rel_from_kb.startswith("qa/") or rel_from_kb.startswith("en/qa/")
        role = "qa" if is_qa else "summary"
        status = "quarantined" if is_quarantined_value(declared_status) else "ready"
        add_source(
            priority_key=f"06:{rel_ws}:000000",
            work_key=f"clec-md:{rel_from_kb}",
            work_title=title,
            path=rel_ws,
            title=title,
            role=role,
            attribution="original_unknown",
            quality="third_party_ai_curated_interpretation_raw_transcripts_absent",
            status=status,
            status_reason="quarantine_do_not_use" if status == "quarantined" else None,
            date=declared_date,
            date_basis="third_party_curated_frontmatter" if declared_date else None,
            origin=f"https://github.com/fraserlai/clec-md/blob/e0f088797a74ab70a1761671dda7dc1c94db374f/knowledge/{rel_from_kb}",
        )

    for group in ("local-asr", "podcast-asr", "quarantine", "ocr"):
        base = workspace / "collection/transcripts" / group
        for entry_dir in sorted(base.iterdir()):
            if not entry_dir.is_dir():
                continue
            dir_name = entry_dir.name
            meta_rel = f"collection/transcripts/{group}/{dir_name}/metadata.json"
            meta_path = workspace / meta_rel
            work_key = f"{group}:{dir_name}"
            if not meta_path.is_file():
                add_inventory_only(meta_rel, work_key, dir_name, "missing", "file_missing")
                continue
            row = json.loads(meta_path.read_text(encoding="utf-8"))
            origin = row.get("media_url") or row.get("video_source") or row.get("source")
            is_q = group == "quarantine" or is_quarantined_value(row.get("status"))
            add_inventory_only(
                meta_rel,
                work_key,
                str(row.get("source_title") or dir_name),
                "quarantined" if is_q else "metadata_only",
                "quarantine_do_not_use" if is_q else "metadata_asset",
            )
            item_id = str(row.get("id") or dir_name)
            main_name = "frames-raw.txt" if group == "ocr" else f"{item_id}.txt"
            main_rel = f"collection/transcripts/{group}/{dir_name}/{main_name}"
            main_title = str(row.get("source_title") or item_id)
            d, db = extract_source_date(main_title, row)
            if (workspace / main_rel).is_file():
                add_source(
                    priority_key=f"07:{meta_rel}:000001",
                    work_key=work_key,
                    work_title=main_title,
                    path=main_rel,
                    title=main_title,
                    role="document" if group == "ocr" else "transcript",
                    attribution="original_unknown" if group == "ocr" else "machine_unverified",
                    quality=(
                        "partial_sampled_frame_ocr_unverified_not_transcript"
                        if group == "ocr"
                        else "local_machine_asr_unverified_no_verified_speakers"
                    ),
                    status="quarantined" if is_q else "ready",
                    status_reason="quarantine_do_not_use" if is_q else None,
                    date=d,
                    date_basis=db,
                    origin=str(origin) if origin else None,
                )
            else:
                non_evidence_items[meta_rel]["status"] = "missing"
                non_evidence_items[meta_rel]["statusReason"] = "file_missing"

            for sibling in sorted(entry_dir.iterdir()):
                sib_name = sibling.name
                if not sib_name.startswith(f"{item_id}.") or sib_name == main_name:
                    continue
                sib_rel = sibling.relative_to(workspace).as_posix()
                if sibling.suffix.lower() in (".srt", ".str", ".vtt"):
                    add_source(
                        priority_key=f"07:{meta_rel}:000002",
                        work_key=work_key,
                        work_title=main_title,
                        path=sib_rel,
                        title=sib_name,
                        role="transcript",
                        attribution="machine_unverified",
                        quality="local_machine_subtitle_unverified_no_verified_speakers",
                        status="quarantined" if is_q else "ready",
                        status_reason="quarantine_do_not_use" if is_q else None,
                        date=d,
                        date_basis=db,
                        origin=str(origin) if origin else None,
                    )
                else:
                    add_inventory_only(
                        sib_rel,
                        work_key,
                        main_title,
                        "quarantined" if is_q else "metadata_only",
                        "quarantine_do_not_use" if is_q else "machine_output_sidecar",
                    )

    for dir_rel in (
        "collection/sources/podcast",
        "collection/sources/drive",
        "collection/web/clec168",
        "collection/web/clectw",
        "collection/web/cfnavi",
    ):
        for p in sorted((workspace / dir_rel).iterdir()):
            if p.is_file() and p.suffix in (".json", ".jsonl", ".xml", ".txt"):
                rel = p.relative_to(workspace).as_posix()
                if rel not in non_evidence_items and rel not in candidates_by_path:
                    add_inventory_only(rel, f"meta:{rel}", p.name, "metadata_only", "metadata_asset")

    for bin_rel in (
        "collection/sources/drive/transcripts.zip",
        "collection/sources/drive/00472-slides.pdf",
        "collection/sources/drive/00514-利率運作.docx",
    ):
        add_inventory_only(bin_rel, f"meta:{bin_rel}", Path(bin_rel).name, "unsupported", "binary_original_not_searchable")

    resolved_sources: list[dict[str, Any]] = []
    for path in sorted(candidates_by_path):
        cands = candidates_by_path[path]
        if path in flagged_clectw:
            for c in cands:
                c["status"] = "quarantined"
                c["statusReason"] = "quality_audit_requires_review"
        q_cands = [c for c in cands if c["status"] == "quarantined"]
        valid_cands = [c for c in cands if c["status"] in ("ready", "metadata_only", "unsupported")]
        pool = q_cands or valid_cands or cands
        pool.sort(key=lambda c: c["_priority"])
        chosen = dict(pool[-1])
        chosen.pop("_priority", None)
        chosen.pop("_expected_sha256", None)
        resolved_sources.append(chosen)

    for path in sorted(non_evidence_items):
        if path not in candidates_by_path:
            resolved_sources.append(non_evidence_items[path])

    resolved_sources.sort(key=lambda s: (s["work"], s["path"]))
    used_works = {s["work"] for s in resolved_sources}
    works_list = [{"key": k, "title": works[k]} for k in sorted(used_works)]

    return {"schemaVersion": 1, "works": works_list, "sources": resolved_sources}, [
        {k: v for k, v in item.items()} for item in resolved_sources
    ]


def build_reconciliation(
    workspace: Path,
    intake: dict[str, Any],
    old_release_db: Path | None,
    old_intake_path: Path | None,
) -> dict[str, Any]:
    sources = intake["sources"]
    ready_sources = [s for s in sources if s["status"] == "ready"]
    by_path = {s["path"]: s for s in sources}

    body_buckets: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for s in ready_sources:
        body_hash = hashlib.sha256(project_body_for_candidate_audit(workspace / s["path"], s["path"]).encode("utf-8")).hexdigest()
        body_buckets[body_hash].append(
            {
                "work": s["work"],
                "path": s["path"],
                "role": s["role"],
                "origin": s.get("origin"),
            }
        )

    same_work_equiv_groups = []
    cross_work_link_candidates = []
    for bhash, items in sorted(body_buckets.items()):
        by_work_role: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
        for item in items:
            by_work_role[(item["work"], item["role"])].append(item)
        for (wk, role), grp in sorted(by_work_role.items()):
            if len(grp) > 1:
                same_work_equiv_groups.append(
                    {"work": wk, "role": role, "bodyHash": bhash, "members": [g["path"] for g in grp]}
                )
        distinct_works = {item["work"] for item in items}
        if len(distinct_works) > 1:
            cross_work_link_candidates.append(
                {
                    "bodyHash": bhash,
                    "distinctWorks": len(distinct_works),
                    "reason": "distinct_work_identities_kept_separate",
                    "members": items,
                }
            )

    rec: dict[str, Any] = {
        "schemaVersion": 1,
        "counts": {
            "declaredWorks": len(intake["works"]),
            "totalInventory": len(sources),
            "readySources": len(ready_sources),
            "byStatus": dict(sorted(collections.Counter(s["status"] for s in sources).items())),
            "byRoleReady": dict(sorted(collections.Counter(s["role"] for s in ready_sources).items())),
            "byAttributionReady": dict(sorted(collections.Counter(s["attribution"] for s in ready_sources).items())),
            "sameWorkEquivalentGroupsCandidate": len(same_work_equiv_groups),
            "crossWorkLinkCandidatesUnmerged": len(cross_work_link_candidates),
        },
        "crossWorkLinkCandidates": cross_work_link_candidates,
    }

    if old_release_db is not None:
        with sqlite3.connect(f"file:{old_release_db}?mode=ro", uri=True) as conn:
            old_sources: dict[str, str] = {}
            for rec_json, in conn.execute("SELECT record FROM sources"):
                r = json.loads(rec_json)
                old_sources[r["path"]] = r["contentHash"]
            old_inv: dict[str, str] = {
                row[0]: row[1] for row in conn.execute("SELECT path, status FROM inventory")
            }

        missing_from_phase2_sources = sorted(set(old_sources) - {s["path"] for s in ready_sources})
        added_in_phase2_sources = sorted({s["path"] for s in ready_sources} - set(old_sources))
        hash_mismatches = []
        for p, old_hash in sorted(old_sources.items()):
            disk_hash = sha256_file(workspace / p)
            if disk_hash != old_hash:
                hash_mismatches.append({"path": p, "oldHash": old_hash, "diskHash": disk_hash})

        missing_from_phase2_inv = sorted(set(old_inv) - set(by_path))
        added_in_phase2_inv = sorted(set(by_path) - set(old_inv))
        status_transitions: dict[str, int] = collections.Counter()
        for p in sorted(set(old_inv) & set(by_path)):
            new_st = "indexed" if by_path[p]["status"] == "ready" else by_path[p]["status"]
            status_transitions[f"{old_inv[p]} -> {new_st}"] += 1

        rec["oldReleaseReconciliation"] = {
            "oldAdmittedSources": len(old_sources),
            "phase2ReadySources": len(ready_sources),
            "missingFromPhase2Ready": missing_from_phase2_sources,
            "addedInPhase2Ready": added_in_phase2_sources,
            "sourceHashMismatchesOnDisk": hash_mismatches,
            "oldInventoryCount": len(old_inv),
            "phase2InventoryCount": len(sources),
            "missingFromPhase2Inventory": missing_from_phase2_inv,
            "addedInPhase2Inventory": added_in_phase2_inv,
            "statusTransitions": dict(sorted(status_transitions.items())),
        }

    if old_intake_path is not None:
        old_intake = json.loads(old_intake_path.read_text(encoding="utf-8"))
        old_intake_paths = {s["path"]: s["status"] for s in old_intake.get("sources", [])}
        rec["oldIntakeReconciliation"] = {
            "oldIntakeSources": len(old_intake_paths),
            "missingFromPhase2": sorted(set(old_intake_paths) - set(by_path)),
            "addedInPhase2": sorted(set(by_path) - set(old_intake_paths)),
        }

    return rec


def subset_intake_by_works(intake: dict[str, Any], limit_works: int) -> dict[str, Any]:
    ready_works = sorted({s["work"] for s in intake["sources"] if s["status"] == "ready"})
    by_family: dict[str, list[str]] = collections.defaultdict(list)
    for wk in ready_works:
        fam = wk.split(":", 1)[0]
        by_family[fam].append(wk)
    selected: list[str] = []
    fams = sorted(by_family)
    idx = 0
    while len(selected) < limit_works and len(selected) < len(ready_works):
        progressed = False
        for fam in fams:
            if idx < len(by_family[fam]):
                selected.append(by_family[fam][idx])
                progressed = True
                if len(selected) >= limit_works:
                    break
        if not progressed:
            break
        idx += 1
    selected_works = set(selected)
    filtered_sources = [s for s in intake["sources"] if s["work"] in selected_works]
    filtered_works = [w for w in intake["works"] if w["key"] in selected_works]
    return {"schemaVersion": 1, "works": filtered_works, "sources": filtered_sources}


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare deterministic Phase 2 CLEC intake and reconciliation")
    parser.add_argument("--workspace", required=True, type=Path, help="CLEC source workspace root")
    parser.add_argument("--old-release", type=Path, help="Optional old corpus.sqlite (read-only) for reconciliation")
    parser.add_argument("--old-intake", type=Path, help="Optional old intake.json for reconciliation")
    parser.add_argument("--output", type=Path, help="Output intake.json path")
    parser.add_argument("--reconciliation", type=Path, help="Output reconciliation.json path")
    parser.add_argument("--limit-works", type=int, help="Optional deterministic subset of ready works")
    parser.add_argument("--dry-run", action="store_true", help="Compute and validate without writing intake.json")
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    intake, _ = prepare_intake(workspace)
    rec = build_reconciliation(
        workspace,
        intake,
        args.old_release.resolve() if args.old_release else None,
        args.old_intake.resolve() if args.old_intake else None,
    )

    if args.limit_works is not None:
        if args.limit_works <= 0:
            raise SystemExit("--limit-works must be positive")
        intake = subset_intake_by_works(intake, args.limit_works)
        rec["subsetLimitWorks"] = args.limit_works
        rec["subsetCounts"] = {
            "works": len(intake["works"]),
            "sources": len(intake["sources"]),
            "readySources": sum(1 for s in intake["sources"] if s["status"] == "ready"),
        }

    if args.reconciliation and not args.dry_run:
        args.reconciliation.parent.mkdir(parents=True, exist_ok=True)
        args.reconciliation.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.output and not args.dry_run:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(intake, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(rec["counts"], ensure_ascii=False, indent=2))
    if "oldReleaseReconciliation" in rec:
        orr = rec["oldReleaseReconciliation"]
        print(
            json.dumps(
                {
                    "oldAdmittedSources": orr["oldAdmittedSources"],
                    "phase2ReadySources": orr["phase2ReadySources"],
                    "missingFromPhase2Ready": len(orr["missingFromPhase2Ready"]),
                    "addedInPhase2Ready": len(orr["addedInPhase2Ready"]),
                    "sourceHashMismatchesOnDisk": len(orr["sourceHashMismatchesOnDisk"]),
                    "oldInventoryCount": orr["oldInventoryCount"],
                    "phase2InventoryCount": orr["phase2InventoryCount"],
                    "missingFromPhase2Inventory": len(orr["missingFromPhase2Inventory"]),
                    "addedInPhase2Inventory": len(orr["addedInPhase2Inventory"]),
                    "statusTransitions": orr["statusTransitions"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
