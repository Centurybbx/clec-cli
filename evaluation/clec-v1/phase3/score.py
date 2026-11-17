"""Pure Phase 3 dataset validation, provenance verification, and evidence scoring."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Any, Literal

try:
    from . import projection
except ImportError:
    import projection


VALID_SPLITS = frozenset({"development", "evaluation"})
VALID_EVIDENCE_KINDS = frozenset({"required", "counterexample", "condition"})
VALID_OUTCOME_STATUSES = frozenset({"completed", "timeout", "error"})
OUTCOME_SCHEMA_VERSION = 2
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")


class CorpusBindingError(ValueError):
    """Raised when active.json or corpus SQLite fails coherence or SHA-256 checks."""


class ProjectionVerificationError(ValueError):
    """Raised when equivalence projection or coordinate mapping fails."""


@dataclass(frozen=True)
class ActiveCorpusBinding:
    data_dir: Path
    release: str
    manifest_path: str
    db_path: Path


def verify_active_corpus_binding(data_dir: Path, expected_sha256: str) -> ActiveCorpusBinding:
    if not SHA256_HEX_RE.match(expected_sha256):
        raise CorpusBindingError(
            f"Expected 64-char lowercase SHA-256 hex, got {expected_sha256!r}"
        )
    resolved_dir = Path(data_dir)
    if not resolved_dir.is_dir():
        raise CorpusBindingError(f"Missing corpus data directory: {resolved_dir}")

    active_json = resolved_dir / "active.json"
    if not active_json.is_file():
        raise CorpusBindingError(f"Missing active.json in {resolved_dir}")

    try:
        active_raw = active_json.read_bytes().decode("utf-8", errors="strict")
        active_obj = json.loads(active_raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CorpusBindingError(f"Invalid active.json in {resolved_dir}: {exc}") from exc

    if not isinstance(active_obj, dict):
        raise CorpusBindingError(f"active.json in {resolved_dir} must be a JSON object")

    release = active_obj.get("release")
    if not isinstance(release, str) or not SHA256_HEX_RE.match(release):
        raise CorpusBindingError(
            f"active.json in {resolved_dir} has invalid release {release!r}"
        )
    if release != expected_sha256:
        raise CorpusBindingError(
            f"active.json release {release!r} != expected {expected_sha256!r}"
        )

    manifest_path = active_obj.get("manifestPath")
    if not isinstance(manifest_path, str) or not manifest_path.strip():
        raise CorpusBindingError(
            f"active.json in {resolved_dir} missing non-empty manifestPath"
        )

    db_path = resolved_dir / f"{expected_sha256}.sqlite"
    if not db_path.is_file():
        raise CorpusBindingError(f"Missing corpus SQLite file: {db_path}")

    return ActiveCorpusBinding(
        data_dir=resolved_dir,
        release=expected_sha256,
        manifest_path=manifest_path,
        db_path=db_path,
    )


def stream_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass(frozen=True)
class ValidatedEvidenceItem:
    source_id: str
    work_id: str
    role: str
    canonical_source_id: str
    equivalence_hash: str
    projection_kind: str
    byte_spans: tuple[tuple[int, int], ...]


class CorpusIndexView:
    """Verified read-only view of an active clec-native-v2 SQLite corpus with bounded lazy caching."""

    def __init__(
        self,
        db_path: Path,
        expected_sha256: str,
        *,
        active_binding: ActiveCorpusBinding | None = None,
        max_cached_blobs: int = 256,
        max_blob_cache_bytes: int = 64 * 1024 * 1024,
        max_cached_passages: int = 4096,
    ) -> None:
        if not SHA256_HEX_RE.match(expected_sha256):
            raise ValueError(f"Expected 64-char lowercase SHA-256 hex, got {expected_sha256!r}")
        self.db_path = Path(db_path)
        if not self.db_path.is_file():
            raise FileNotFoundError(f"Missing corpus SQLite file: {self.db_path}")
        if active_binding is not None and (
            active_binding.release != expected_sha256
            or active_binding.db_path.resolve() != self.db_path.resolve()
        ):
            raise CorpusBindingError("ActiveCorpusBinding does not match opened SQLite path")

        self.active_binding = active_binding
        self.expected_sha256 = expected_sha256
        self.actual_sha256 = stream_sha256(self.db_path)
        if self.actual_sha256 != self.expected_sha256:
            raise ValueError(
                f"Corpus SQLite SHA-256 mismatch for {self.db_path}: "
                f"expected {self.expected_sha256}, actual {self.actual_sha256}"
            )

        self.corpus_format: str = ""
        self.works_by_key: dict[str, str] = {}
        self.works_by_id: dict[str, dict[str, str]] = {}
        self.sources: dict[str, dict[str, Any]] = {}

        self._max_cached_blobs = max(1, max_cached_blobs)
        self._max_blob_cache_bytes = max(1024, max_blob_cache_bytes)
        self._max_cached_passages = max(1, max_cached_passages)
        self._blob_cache: OrderedDict[str, bytes] = OrderedDict()
        self._blob_cache_bytes = 0
        self._cues_cache: OrderedDict[str, list[tuple[int, int]]] = OrderedDict()
        self._proj_cache: OrderedDict[str, projection.ProjectedSource] = OrderedDict()
        self._passage_cache: OrderedDict[str, dict[str, Any] | None] = OrderedDict()

        self._conn: sqlite3.Connection | None = sqlite3.connect(
            f"file:{self.db_path}?mode=ro", uri=True
        )
        self._load_metadata_and_catalog()

    @classmethod
    def open_active(
        cls,
        data_dir: Path,
        expected_sha256: str,
        *,
        max_cached_blobs: int = 256,
        max_blob_cache_bytes: int = 64 * 1024 * 1024,
        max_cached_passages: int = 4096,
    ) -> CorpusIndexView:
        binding = verify_active_corpus_binding(data_dir, expected_sha256)
        return cls(
            binding.db_path,
            expected_sha256,
            active_binding=binding,
            max_cached_blobs=max_cached_blobs,
            max_blob_cache_bytes=max_blob_cache_bytes,
            max_cached_passages=max_cached_passages,
        )

    def _require_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("CorpusIndexView is closed")
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> CorpusIndexView:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def verify_db_file_unchanged(self) -> bool:
        if stream_sha256(self.db_path) != self.actual_sha256:
            return False
        if self.active_binding is not None:
            try:
                current = verify_active_corpus_binding(
                    self.active_binding.data_dir, self.expected_sha256
                )
            except CorpusBindingError:
                return False
            return current == self.active_binding
        return True

    def _load_metadata_and_catalog(self) -> None:
        conn = self._require_conn()
        fmt = conn.execute("SELECT value FROM metadata WHERE key='corpus_format'").fetchone()
        if not fmt or fmt[0] != "clec-native-v2":
            raise ValueError(f"Expected clec-native-v2 database, got {fmt}")
        self.corpus_format = str(fmt[0])

        for wid, wkey, title in conn.execute("SELECT id, work_key, title FROM works"):
            self.works_by_key[wkey] = wid
            self.works_by_id[wid] = {"workId": wid, "workKey": wkey, "title": title}

        for (
            sid,
            wid,
            path,
            title,
            role,
            chash,
            canon_sid,
            eq_hash,
            proj_kind,
            eq_basis,
        ) in conn.execute(
            "SELECT s.id, s.work_id, s.path, s.title, s.role, s.content_hash, "
            "m.canonical_source_id, m.equivalence_hash, m.projection_kind, m.equivalence_basis "
            "FROM sources s JOIN source_canonical_map m ON m.source_id = s.id"
        ):
            self.sources[sid] = {
                "sourceId": sid,
                "workId": wid,
                "path": path,
                "title": title,
                "role": role,
                "contentHash": chash,
                "canonicalSourceId": canon_sid,
                "equivalenceHash": eq_hash,
                "projectionKind": proj_kind,
                "equivalenceBasis": eq_basis,
            }

    def _blob_by_hash(self, content_hash: str) -> bytes:
        cached = self._blob_cache.get(content_hash)
        if cached is not None:
            self._blob_cache.move_to_end(content_hash)
            return cached
        row = self._require_conn().execute(
            "SELECT raw_bytes FROM blobs WHERE content_hash = ?",
            (content_hash,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Missing blob for content_hash {content_hash}")
        raw = bytes(row[0])
        if hashlib.sha256(raw).hexdigest() != content_hash:
            raise ValueError(f"Blob SHA-256 mismatch for content_hash {content_hash}")
        if len(raw) <= self._max_blob_cache_bytes:
            while (
                len(self._blob_cache) >= self._max_cached_blobs
                or self._blob_cache_bytes + len(raw) > self._max_blob_cache_bytes
            ) and self._blob_cache:
                _, evicted = self._blob_cache.popitem(last=False)
                self._blob_cache_bytes -= len(evicted)
            self._blob_cache[content_hash] = raw
            self._blob_cache_bytes += len(raw)
        return raw

    def raw_bytes_for_source(self, source_id: str) -> bytes:
        src = self.sources[source_id]
        return self._blob_by_hash(src["contentHash"])

    def cues_for_source(self, source_id: str) -> list[tuple[int, int]]:
        cached = self._cues_cache.get(source_id)
        if cached is not None:
            self._cues_cache.move_to_end(source_id)
            return cached
        cues = [
            (int(ts), int(te))
            for ts, te in self._require_conn().execute(
                "SELECT text_start_byte, text_end_byte FROM cues WHERE source_id = ? ORDER BY ordinal",
                (source_id,),
            )
        ]
        if len(self._cues_cache) >= self._max_cached_blobs:
            self._cues_cache.popitem(last=False)
        self._cues_cache[source_id] = cues
        return cues

    def projected_for_source(self, source_id: str) -> projection.ProjectedSource:
        cached = self._proj_cache.get(source_id)
        if cached is not None:
            self._proj_cache.move_to_end(source_id)
            return cached
        src = self.sources[source_id]
        raw = self.raw_bytes_for_source(source_id)
        cues = self.cues_for_source(source_id)
        try:
            proj = projection.project_source(raw, src["projectionKind"], cues)
        except (ValueError, TypeError, UnicodeDecodeError) as exc:
            raise ProjectionVerificationError(
                f"Failed to project {source_id}: {exc}"
            ) from exc
        if proj.equivalence_hash != src["equivalenceHash"]:
            raise ProjectionVerificationError(
                f"Projected equivalence_hash mismatch for {source_id}: "
                f"{proj.equivalence_hash} != {src['equivalenceHash']}"
            )
        if len(self._proj_cache) >= self._max_cached_blobs:
            self._proj_cache.popitem(last=False)
        self._proj_cache[source_id] = proj
        return proj

    def passage_by_id(self, passage_id: str) -> dict[str, Any] | None:
        if passage_id in self._passage_cache:
            self._passage_cache.move_to_end(passage_id)
            return self._passage_cache[passage_id]
        conn = self._require_conn()
        row = conn.execute(
            "SELECT id, source_id, work_id, ordinal, text FROM passages WHERE id = ?",
            (passage_id,),
        ).fetchone()
        if row is None:
            entry = None
        else:
            spans = [
                (int(sb), int(eb), (int(co) if co is not None else None))
                for sb, eb, co in conn.execute(
                    "SELECT start_byte, end_byte, cue_ordinal FROM passage_spans "
                    "WHERE passage_id = ? ORDER BY span_ordinal",
                    (passage_id,),
                )
            ]
            entry = {
                "passageId": row[0],
                "sourceId": row[1],
                "workId": row[2],
                "ordinal": int(row[3]),
                "text": row[4],
                "spans": spans,
            }
        if len(self._passage_cache) >= self._max_cached_passages:
            self._passage_cache.popitem(last=False)
        self._passage_cache[passage_id] = entry
        return entry

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
    if corpus.actual_sha256 != active_release_sha256:
        errors.append(
            {
                "field": "actualCorpusSha256",
                "error": f"Verified DB SHA-256 {corpus.actual_sha256!r} != active release {active_release_sha256!r}",
            }
        )
    ds_sha = dataset.get("corpusSha256")
    if ds_sha != corpus.actual_sha256:
        errors.append(
            {
                "field": "corpusSha256",
                "error": f"Dataset corpusSha256 {ds_sha!r} != verified active release {corpus.actual_sha256!r}",
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
                try:
                    sb_v, eb_v = projection.validate_utf8_byte_range(raw, sb, eb)
                    parts.append(raw[sb_v:eb_v].decode("utf-8", errors="strict"))
                except (ValueError, UnicodeDecodeError) as exc:
                    errors.append(
                        {
                            "questionId": qid,
                            "evidenceIndex": idx,
                            "span": sp,
                            "error": f"Invalid UTF-8 byte span range: {exc}",
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


def _validate_spans_against_raw_and_db(
    spans: Any,
    raw: bytes,
    expected_db_spans: list[tuple[int, int, int | None]],
    expected_text: str,
    db_text: str,
    *,
    sid: str,
    item_index: int,
    context_index: int | None = None,
) -> tuple[list[tuple[int, int]] | None, list[dict[str, Any]]]:
    loc: dict[str, Any] = {"itemIndex": item_index, "sourceId": sid}
    if context_index is not None:
        loc["contextIndex"] = context_index
    if not isinstance(spans, list) or not spans or not isinstance(expected_text, str):
        return None, [{**loc, "error": "Missing spans or text"}]

    observed_tuples: list[tuple[int, int, int | None]] = []
    byte_pairs: list[tuple[int, int]] = []
    parts: list[str] = []
    for sp in spans:
        if not isinstance(sp, dict):
            return None, [{**loc, "span": sp, "error": "Span must be an object"}]
        sb = sp.get("startByte")
        eb = sp.get("endByte")
        co = sp.get("cueOrdinal")
        if co is not None and (isinstance(co, bool) or not isinstance(co, int)):
            return None, [{**loc, "span": sp, "error": "Invalid cueOrdinal type"}]
        try:
            sb_v, eb_v = projection.validate_utf8_byte_range(raw, sb, eb)
            parts.append(raw[sb_v:eb_v].decode("utf-8", errors="strict"))
        except (ValueError, UnicodeDecodeError) as exc:
            return None, [{**loc, "span": sp, "error": f"Invalid span against raw_bytes: {exc}"}]
        observed_tuples.append((sb_v, eb_v, co))
        byte_pairs.append((sb_v, eb_v))

    if observed_tuples != expected_db_spans:
        return None, [
            {
                **loc,
                "error": "Declared spans do not match authoritative DB passage_spans",
                "declared": observed_tuples,
                "expected": expected_db_spans,
            }
        ]
    reconstructed = "\n".join(parts)
    if reconstructed != expected_text or expected_text != db_text:
        return None, [{**loc, "error": "Returned text differs from authoritative raw_bytes[spans] or DB passage text"}]
    return byte_pairs, []


def validate_returned_item(
    item: Any,
    corpus: CorpusIndexView,
    *,
    item_index: int,
) -> tuple[ValidatedEvidenceItem | None, list[dict[str, Any]]]:
    if not isinstance(item, dict):
        return None, [{"itemIndex": item_index, "error": "Returned item must be an object"}]

    source_obj = item.get("source")
    if not isinstance(source_obj, dict):
        return None, [{"itemIndex": item_index, "error": "Missing source object"}]
    sid = source_obj.get("sourceId")
    if not isinstance(sid, str) or sid not in corpus.sources:
        return None, [{"itemIndex": item_index, "sourceId": sid, "error": "Unknown sourceId in CLI output"}]

    src_meta = corpus.sources[sid]
    work_meta = corpus.works_by_id[src_meta["workId"]]

    for key, db_key in (
        ("workId", "workId"),
        ("path", "path"),
        ("role", "role"),
        ("contentHash", "contentHash"),
        ("canonicalSourceId", "canonicalSourceId"),
    ):
        if source_obj.get(key) != src_meta[db_key]:
            return None, [
                {
                    "itemIndex": item_index,
                    "sourceId": sid,
                    "error": f"Source metadata mismatch for source.{key}",
                    "declared": source_obj.get(key),
                    "expected": src_meta[db_key],
                }
            ]
    for opt_key in ("equivalenceBasis", "projectionKind", "equivalenceHash"):
        if opt_key in source_obj and source_obj[opt_key] != src_meta[opt_key]:
            return None, [
                {
                    "itemIndex": item_index,
                    "sourceId": sid,
                    "error": f"Source metadata mismatch for source.{opt_key}",
                }
            ]

    work_obj = item.get("work")
    if not isinstance(work_obj, dict):
        return None, [{"itemIndex": item_index, "sourceId": sid, "error": "Missing work object"}]
    if work_obj.get("workId") != work_meta["workId"] or work_obj.get("workKey") != work_meta["workKey"]:
        return None, [
            {
                "itemIndex": item_index,
                "sourceId": sid,
                "error": "Work metadata mismatch against DB works table",
            }
        ]
    if "title" in work_obj and work_obj["title"] != work_meta["title"]:
        return None, [
            {
                "itemIndex": item_index,
                "sourceId": sid,
                "error": "Work title mismatch against DB works table",
            }
        ]

    try:
        raw = corpus.raw_bytes_for_source(sid)
    except (KeyError, ValueError) as exc:
        return None, [{"itemIndex": item_index, "sourceId": sid, "error": f"Blob provenance error: {exc}"}]

    kind = item.get("kind")
    if kind == "sourceOverview":
        if "originalText" in item or "spans" in item or "text" in item:
            return None, [{"itemIndex": item_index, "sourceId": sid, "error": "sourceOverview must not carry text or spans"}]
        return None, []

    if kind == "sourceOriginal" or "originalText" in item:
        if kind is not None and kind != "sourceOriginal":
            return None, [{"itemIndex": item_index, "sourceId": sid, "error": f"Invalid kind {kind!r} for sourceOriginal"}]
        if "passageId" in item or "spans" in item or "text" in item:
            return None, [{"itemIndex": item_index, "sourceId": sid, "error": "sourceOriginal must not carry passageId, spans, or text"}]
        try:
            decoded_raw = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            return None, [{"itemIndex": item_index, "sourceId": sid, "error": f"Stored blob is not valid UTF-8: {exc}"}]
        if item.get("originalText") != decoded_raw:
            return None, [{"itemIndex": item_index, "sourceId": sid, "error": "originalText does not match raw bytes"}]
        if "byteLen" in item and item["byteLen"] != len(raw):
            return None, [{"itemIndex": item_index, "sourceId": sid, "error": "byteLen does not match raw bytes length"}]
        return (
            ValidatedEvidenceItem(
                source_id=sid,
                work_id=src_meta["workId"],
                role=src_meta["role"],
                canonical_source_id=src_meta["canonicalSourceId"],
                equivalence_hash=src_meta["equivalenceHash"],
                projection_kind=src_meta["projectionKind"],
                byte_spans=((0, len(raw)),),
            ),
            [],
        )

    if kind is not None and kind != "passage":
        return None, [{"itemIndex": item_index, "sourceId": sid, "error": f"Unsupported item kind {kind!r}"}]

    pid = item.get("passageId")
    if not isinstance(pid, str) or not pid:
        return None, [{"itemIndex": item_index, "sourceId": sid, "error": "Missing passageId"}]
    db_passage = corpus.passage_by_id(pid)
    if db_passage is None:
        return None, [{"itemIndex": item_index, "sourceId": sid, "passageId": pid, "error": "Unknown passageId in DB"}]
    if db_passage["sourceId"] != sid or db_passage["workId"] != src_meta["workId"]:
        return None, [
            {
                "itemIndex": item_index,
                "sourceId": sid,
                "passageId": pid,
                "error": "passageId does not belong to declared sourceId or workId",
            }
        ]
    if item.get("ordinal") != db_passage["ordinal"]:
        return None, [
            {
                "itemIndex": item_index,
                "sourceId": sid,
                "passageId": pid,
                "error": "Passage ordinal mismatch against DB",
            }
        ]

    main_pairs, span_errs = _validate_spans_against_raw_and_db(
        item.get("spans"),
        raw,
        db_passage["spans"],
        item.get("text"),
        db_passage["text"],
        sid=sid,
        item_index=item_index,
    )
    if span_errs or main_pairs is None:
        return None, span_errs

    all_byte_spans = list(main_pairs)
    ctx_list = item.get("context") or []
    if not isinstance(ctx_list, list):
        return None, [{"itemIndex": item_index, "sourceId": sid, "error": "context must be a list"}]

    for c_idx, ctx in enumerate(ctx_list):
        if not isinstance(ctx, dict):
            return None, [{"itemIndex": item_index, "contextIndex": c_idx, "sourceId": sid, "error": "Context item must be an object"}]
        ctx_pid = ctx.get("passageId")
        if not isinstance(ctx_pid, str) or not ctx_pid:
            return None, [{"itemIndex": item_index, "contextIndex": c_idx, "sourceId": sid, "error": "Missing context passageId"}]
        db_ctx = corpus.passage_by_id(ctx_pid)
        if db_ctx is None or db_ctx["sourceId"] != sid or db_ctx["workId"] != src_meta["workId"]:
            return None, [
                {
                    "itemIndex": item_index,
                    "contextIndex": c_idx,
                    "sourceId": sid,
                    "passageId": ctx_pid,
                    "error": "Context passageId missing or belongs to wrong source/work",
                }
            ]
        if ctx.get("ordinal") != db_ctx["ordinal"]:
            return None, [
                {
                    "itemIndex": item_index,
                    "contextIndex": c_idx,
                    "sourceId": sid,
                    "passageId": ctx_pid,
                    "error": "Context ordinal mismatch against DB",
                }
            ]
        ctx_pairs, ctx_errs = _validate_spans_against_raw_and_db(
            ctx.get("spans"),
            raw,
            db_ctx["spans"],
            ctx.get("text"),
            db_ctx["text"],
            sid=sid,
            item_index=item_index,
            context_index=c_idx,
        )
        if ctx_errs or ctx_pairs is None:
            return None, ctx_errs
        all_byte_spans.extend(ctx_pairs)

    return (
        ValidatedEvidenceItem(
            source_id=sid,
            work_id=src_meta["workId"],
            role=src_meta["role"],
            canonical_source_id=src_meta["canonicalSourceId"],
            equivalence_hash=src_meta["equivalenceHash"],
            projection_kind=src_meta["projectionKind"],
            byte_spans=tuple(all_byte_spans),
        ),
        [],
    )


def verify_returned_citation_spans(
    items: list[dict[str, Any]],
    corpus: CorpusIndexView,
) -> list[dict[str, Any]]:
    """Audit every returned hit/read item against authoritative DB metadata, passages, and raw source bytes."""
    failures: list[dict[str, Any]] = []
    for idx, item in enumerate(items):
        _, errs = validate_returned_item(item, corpus, item_index=idx)
        failures.extend(errs)
    return failures


def _item_covers_evidence(
    ev: dict[str, Any],
    validated_items: list[ValidatedEvidenceItem],
    corpus: CorpusIndexView,
) -> bool:
    gold_sid = ev["sourceId"]
    gold_spans = [(int(sp["startByte"]), int(sp["endByte"])) for sp in ev["spans"]]

    direct_spans: list[tuple[int, int]] = []
    for item in validated_items:
        if item.source_id == gold_sid:
            direct_spans.extend(item.byte_spans)

    if direct_spans and all(projection.intervals_cover(direct_spans, gs) for gs in gold_spans):
        return True

    gold_proj = corpus.projected_for_source(gold_sid)
    try:
        gold_coord_intervals = gold_proj.project_byte_spans(gold_spans)
    except ValueError as exc:
        raise ProjectionVerificationError(
            f"Gold byte span projection failed for {gold_sid}: {exc}"
        ) from exc
    if not gold_coord_intervals:
        return False

    alias_coord_intervals: list[tuple[int, int]] = []
    for item in validated_items:
        if item.source_id == gold_sid:
            continue
        if not corpus.are_canonical_aliases(gold_sid, item.source_id):
            continue
        item_proj = corpus.projected_for_source(item.source_id)
        try:
            alias_coord_intervals.extend(item_proj.project_byte_spans(item.byte_spans))
        except ValueError as exc:
            raise ProjectionVerificationError(
                f"Returned item byte span projection failed for {item.source_id}: {exc}"
            ) from exc

    return bool(alias_coord_intervals) and all(
        projection.intervals_cover(alias_coord_intervals, gci) for gci in gold_coord_intervals
    )


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


@dataclass(frozen=True)
class CompletedStep:
    step_name: str
    stdout_bytes: int
    stderr_bytes: int
    items: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class FailedStep:
    step_name: str
    stdout_bytes: int
    stderr_bytes: int
    timed_out: bool
    reason: str
    undecodable_output: bool = False


ParsedStep = CompletedStep | FailedStep


@dataclass(frozen=True)
class ScoreableExecution:
    completed_steps: tuple[CompletedStep, ...]
    all_steps: tuple[ParsedStep, ...]
    search_stdout_bytes: int
    read_stdout_bytes: int
    stderr_bytes: int


@dataclass(frozen=True)
class NonScoreableExecution:
    status: Literal["error", "timeout", "inconclusive"]
    stop_reason: str
    completed_steps: tuple[CompletedStep, ...]
    all_steps: tuple[ParsedStep, ...]
    search_stdout_bytes: int
    read_stdout_bytes: int
    stderr_bytes: int
    undecodable_reasons: tuple[str, ...]


ExecutionOutcome = ScoreableExecution | NonScoreableExecution


def _is_int_non_bool(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_valid_v2_outcome(outcome: Any) -> tuple[bool, str | None]:
    if not isinstance(outcome, dict):
        return False, "Outcome must be an object"
    if outcome.get("outcomeSchemaVersion") != OUTCOME_SCHEMA_VERSION:
        return (
            False,
            f"Unsupported outcomeSchemaVersion {outcome.get('outcomeSchemaVersion')!r}; expected {OUTCOME_SCHEMA_VERSION} with raw stdoutUtf8",
        )
    steps = outcome.get("steps")
    if not isinstance(steps, list):
        return False, "Outcome v2 requires a steps list"
    for idx, step in enumerate(steps):
        if not isinstance(step, dict):
            return False, f"Step {idx} must be an object"
        if step.get("step") not in ("search", "read"):
            return False, f"Step {idx} has invalid step kind {step.get('step')!r}"
        if "argv" in step:
            argv = step["argv"]
            if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
                return False, f"Step {idx} has invalid argv"
        if not isinstance(step.get("timedOut"), bool):
            return False, f"Step {idx} missing boolean timedOut"
        exit_code = step.get("exitCode")
        if exit_code is not None and not _is_int_non_bool(exit_code):
            return False, f"Step {idx} has invalid exitCode {exit_code!r}"

        stdout_utf8 = step.get("stdoutUtf8")
        stdout_err = step.get("stdoutDecodeError")
        if isinstance(stdout_utf8, str):
            if stdout_err is not None:
                return False, f"Step {idx} has both stdoutUtf8 string and stdoutDecodeError"
        elif stdout_utf8 is None:
            if not isinstance(stdout_err, str) or not stdout_err:
                return False, f"Step {idx} missing raw stdoutUtf8 string or stdoutDecodeError"
        else:
            return False, f"Step {idx} has invalid stdoutUtf8 type"

        stderr_utf8 = step.get("stderrUtf8")
        stderr_err = step.get("stderrDecodeError")
        if isinstance(stderr_utf8, str):
            if stderr_err is not None:
                return False, f"Step {idx} has both stderrUtf8 string and stderrDecodeError"
        elif stderr_utf8 is None:
            if not isinstance(stderr_err, str) or not stderr_err:
                return False, f"Step {idx} missing raw stderrUtf8 string or stderrDecodeError"
        else:
            return False, f"Step {idx} has invalid stderrUtf8 type"
    return True, None


def _parse_step_payload(step: dict[str, Any], corpus: CorpusIndexView) -> ParsedStep:
    step_name = str(step["step"])
    stdout_utf8: str | None = step["stdoutUtf8"]
    stderr_utf8: str | None = step["stderrUtf8"]
    stdout_err: str | None = step.get("stdoutDecodeError")
    stderr_err: str | None = step.get("stderrDecodeError")
    raw_len_field = step.get("stdoutRawByteLen")

    if stdout_utf8 is not None:
        stdout_bytes = len(stdout_utf8.encode("utf-8"))
        if raw_len_field is not None and (
            not _is_int_non_bool(raw_len_field) or raw_len_field != stdout_bytes
        ):
            return FailedStep(
                step_name=step_name,
                stdout_bytes=stdout_bytes,
                stderr_bytes=len(stderr_utf8.encode("utf-8")) if stderr_utf8 is not None else 0,
                timed_out=bool(step["timedOut"]),
                reason=f"{step_name}_stdout_raw_byte_len_mismatch:{raw_len_field}!={stdout_bytes}",
            )
    else:
        stdout_bytes = int(raw_len_field) if _is_int_non_bool(raw_len_field) and raw_len_field >= 0 else 0

    if stderr_utf8 is not None:
        stderr_bytes = len(stderr_utf8.encode("utf-8"))
    else:
        stderr_raw_len = step.get("stderrRawByteLen")
        stderr_bytes = int(stderr_raw_len) if _is_int_non_bool(stderr_raw_len) and stderr_raw_len >= 0 else 0

    timed_out = bool(step["timedOut"])
    exit_code = step.get("exitCode")

    if stdout_err is not None:
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=timed_out,
            reason=f"{step_name}_undecodable_stdout:{stdout_err}",
            undecodable_output=True,
        )
    if stderr_err is not None:
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=timed_out,
            reason=f"{step_name}_undecodable_stderr:{stderr_err}",
            undecodable_output=True,
        )

    if timed_out:
        if exit_code == 0:
            reason = f"{step_name}_incoherent_timedOut_with_zero_exit"
        else:
            reason = f"{step_name}_timeout"
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=True,
            reason=reason,
        )

    if exit_code is None:
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=False,
            reason=f"{step_name}_missing_exitCode_without_timeout",
        )

    if exit_code != 0:
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=False,
            reason=f"{step_name}_exit_{exit_code}",
        )

    assert stdout_utf8 is not None
    try:
        payload = json.loads(stdout_utf8)
    except json.JSONDecodeError as exc:
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=False,
            reason=f"invalid_{step_name}_stdout_json:{exc}",
        )

    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion") != 1
        or payload.get("ok") is not True
        or payload.get("command") != step_name
    ):
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=False,
            reason=f"invalid_{step_name}_envelope",
        )

    data = payload.get("data")
    if not isinstance(data, dict) or data.get("release") != corpus.actual_sha256:
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=False,
            reason=f"{step_name}_release_mismatch",
        )

    budget_obj = data.get("budget")
    if isinstance(budget_obj, dict) and "usedBytes" in budget_obj:
        if budget_obj["usedBytes"] != stdout_bytes:
            return FailedStep(
                step_name=step_name,
                stdout_bytes=stdout_bytes,
                stderr_bytes=stderr_bytes,
                timed_out=False,
                reason=f"{step_name}_budget_usedBytes_mismatch:{budget_obj['usedBytes']}!={stdout_bytes}",
            )

    raw_items = data.get("hits") if step_name == "search" else data.get("items")
    if not isinstance(raw_items, list):
        return FailedStep(
            step_name=step_name,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=False,
            reason=f"invalid_{step_name}_items_list",
        )
    return CompletedStep(
        step_name=step_name,
        stdout_bytes=stdout_bytes,
        stderr_bytes=stderr_bytes,
        items=tuple(raw_items),
    )


def _derive_execution_outcome(
    outcome: dict[str, Any], corpus: CorpusIndexView
) -> ExecutionOutcome:
    raw_status = outcome.get("status")
    stop_reason = outcome.get("stopReason")
    if stop_reason is not None and not isinstance(stop_reason, str):
        stop_reason = str(stop_reason)

    parsed_steps = tuple(_parse_step_payload(step, corpus) for step in outcome["steps"])
    completed_steps = tuple(s for s in parsed_steps if isinstance(s, CompletedStep))
    failed_steps = tuple(s for s in parsed_steps if isinstance(s, FailedStep))
    search_stdout_bytes = sum(s.stdout_bytes for s in parsed_steps if s.step_name == "search")
    read_stdout_bytes = sum(s.stdout_bytes for s in parsed_steps if s.step_name == "read")
    stderr_bytes = sum(s.stderr_bytes for s in parsed_steps)
    undecodable_reasons = tuple(s.reason for s in failed_steps if s.undecodable_output)

    if raw_status not in VALID_OUTCOME_STATUSES:
        return NonScoreableExecution(
            status="inconclusive",
            stop_reason=f"incoherent_outcome:invalid_status:{raw_status!r}",
            completed_steps=completed_steps,
            all_steps=parsed_steps,
            search_stdout_bytes=search_stdout_bytes,
            read_stdout_bytes=read_stdout_bytes,
            stderr_bytes=stderr_bytes,
            undecodable_reasons=undecodable_reasons,
        )

    if failed_steps:
        first_fail = failed_steps[0]
        timeout_fail = next((s for s in failed_steps if s.timed_out), None)
        if raw_status == "completed":
            kind = "completed_with_timed_out_step" if timeout_fail is not None else "completed_with_failed_step"
            detail = timeout_fail.reason if timeout_fail is not None else first_fail.reason
            return NonScoreableExecution(
                status="error",
                stop_reason=f"incoherent_outcome:{kind}:{detail}",
                completed_steps=completed_steps,
                all_steps=parsed_steps,
                search_stdout_bytes=search_stdout_bytes,
                read_stdout_bytes=read_stdout_bytes,
                stderr_bytes=stderr_bytes,
                undecodable_reasons=undecodable_reasons,
            )
        if raw_status == "timeout" and timeout_fail is None:
            return NonScoreableExecution(
                status="inconclusive",
                stop_reason=f"incoherent_outcome:timeout_without_timed_out_step:{first_fail.reason}",
                completed_steps=completed_steps,
                all_steps=parsed_steps,
                search_stdout_bytes=search_stdout_bytes,
                read_stdout_bytes=read_stdout_bytes,
                stderr_bytes=stderr_bytes,
                undecodable_reasons=undecodable_reasons,
            )
        resolved_status: Literal["error", "timeout"] = "timeout" if raw_status == "timeout" else "error"
        return NonScoreableExecution(
            status=resolved_status,
            stop_reason=stop_reason or first_fail.reason,
            completed_steps=completed_steps,
            all_steps=parsed_steps,
            search_stdout_bytes=search_stdout_bytes,
            read_stdout_bytes=read_stdout_bytes,
            stderr_bytes=stderr_bytes,
            undecodable_reasons=undecodable_reasons,
        )

    if raw_status == "completed":
        if not completed_steps:
            return NonScoreableExecution(
                status="inconclusive",
                stop_reason="incoherent_outcome:completed_with_no_steps",
                completed_steps=completed_steps,
                all_steps=parsed_steps,
                search_stdout_bytes=search_stdout_bytes,
                read_stdout_bytes=read_stdout_bytes,
                stderr_bytes=stderr_bytes,
                undecodable_reasons=undecodable_reasons,
            )
        return ScoreableExecution(
            completed_steps=completed_steps,
            all_steps=parsed_steps,
            search_stdout_bytes=search_stdout_bytes,
            read_stdout_bytes=read_stdout_bytes,
            stderr_bytes=stderr_bytes,
        )

    if raw_status == "timeout":
        return NonScoreableExecution(
            status="inconclusive",
            stop_reason="incoherent_outcome:timeout_without_timed_out_step",
            completed_steps=completed_steps,
            all_steps=parsed_steps,
            search_stdout_bytes=search_stdout_bytes,
            read_stdout_bytes=read_stdout_bytes,
            stderr_bytes=stderr_bytes,
            undecodable_reasons=undecodable_reasons,
        )

    if completed_steps and not stop_reason:
        return NonScoreableExecution(
            status="inconclusive",
            stop_reason="incoherent_outcome:error_without_failed_step",
            completed_steps=completed_steps,
            all_steps=parsed_steps,
            search_stdout_bytes=search_stdout_bytes,
            read_stdout_bytes=read_stdout_bytes,
            stderr_bytes=stderr_bytes,
            undecodable_reasons=undecodable_reasons,
        )
    if completed_steps and stop_reason:
        return NonScoreableExecution(
            status="inconclusive",
            stop_reason=f"incoherent_outcome:error_with_only_succeeded_steps:{stop_reason}",
            completed_steps=completed_steps,
            all_steps=parsed_steps,
            search_stdout_bytes=search_stdout_bytes,
            read_stdout_bytes=read_stdout_bytes,
            stderr_bytes=stderr_bytes,
            undecodable_reasons=undecodable_reasons,
        )
    return NonScoreableExecution(
        status="error",
        stop_reason=stop_reason or "error",
        completed_steps=completed_steps,
        all_steps=parsed_steps,
        search_stdout_bytes=search_stdout_bytes,
        read_stdout_bytes=read_stdout_bytes,
        stderr_bytes=stderr_bytes,
        undecodable_reasons=undecodable_reasons,
    )


def _null_outcome_row(
    question: dict[str, Any],
    *,
    outcome_schema_version: Any,
    outcome_version_valid: bool,
    status: str,
    stop_reason: str,
    top_k: int,
    stdout_byte_budget: int | None,
    read_byte_budget: int | None,
    cumulative_stdout_byte_budget: int | None,
    search_stdout_bytes: int,
    read_stdout_bytes: int,
    cumulative_stdout_bytes: int,
    stderr_bytes: int,
    budget_exceeded: bool,
    citation_ok: bool,
    citation_failures: list[dict[str, Any]],
    obligation_count: int,
    condition_count: int,
    counterexample_count: int,
) -> dict[str, Any]:
    return {
        "id": question["id"],
        "category": question.get("category"),
        "answerable": question["answerable"],
        "outcomeSchemaVersion": outcome_schema_version,
        "outcomeVersionValid": outcome_version_valid,
        "status": status,
        "stopReason": stop_reason,
        "topK": top_k,
        "stdoutByteBudget": stdout_byte_budget,
        "readByteBudget": read_byte_budget,
        "cumulativeStdoutByteBudget": cumulative_stdout_byte_budget,
        "searchStdoutUtf8Bytes": search_stdout_bytes,
        "readStdoutUtf8Bytes": read_stdout_bytes,
        "cumulativeStdoutUtf8Bytes": cumulative_stdout_bytes,
        "stderrUtf8Bytes": stderr_bytes,
        "stdoutBudgetExceeded": budget_exceeded,
        "tokenBudget": None,
        "tokenMetricNote": "UTF-8 bytes are not tokens; token budget requires model tokenizer",
        "citationRawSpanValid": citation_ok,
        "citationFailures": citation_failures,
        "obligationCount": obligation_count,
        "coveredObligations": None,
        "evidenceCoverage": None,
        "completeChain": None,
        "conditionCount": condition_count,
        "conditionsCovered": None,
        "conditionLoss": None,
        "counterexampleCount": counterexample_count,
        "counterexamplesCovered": None,
        "counterexampleLoss": None,
    }


def score_question(
    question: dict[str, Any],
    outcome: dict[str, Any],
    corpus: CorpusIndexView,
    *,
    top_k: int = 5,
    stdout_byte_budget: int | None = None,
    read_byte_budget: int | None = None,
    cumulative_stdout_byte_budget: int | None = None,
) -> dict[str, Any]:
    obligations = _build_obligations(question.get("evidence", []))
    cond_obs = [ob for ob in obligations if any(ev.get("kind") == "condition" for ev in ob)]
    ce_obs = [ob for ob in obligations if any(ev.get("kind") == "counterexample" for ev in ob)]

    v2_ok, v2_err = _is_valid_v2_outcome(outcome)
    if not v2_ok:
        return _null_outcome_row(
            question,
            outcome_schema_version=outcome.get("outcomeSchemaVersion") if isinstance(outcome, dict) else None,
            outcome_version_valid=False,
            status="inconclusive",
            stop_reason=f"unsupported_outcome_version:{v2_err}",
            top_k=top_k,
            stdout_byte_budget=stdout_byte_budget,
            read_byte_budget=read_byte_budget,
            cumulative_stdout_byte_budget=cumulative_stdout_byte_budget,
            search_stdout_bytes=0,
            read_stdout_bytes=0,
            cumulative_stdout_bytes=0,
            stderr_bytes=0,
            budget_exceeded=False,
            citation_ok=False,
            citation_failures=[{"error": v2_err}],
            obligation_count=len(obligations),
            condition_count=len(cond_obs),
            counterexample_count=len(ce_obs),
        )

    execution = _derive_execution_outcome(outcome, corpus)

    all_citation_failures: list[dict[str, Any]] = []
    if isinstance(execution, NonScoreableExecution) and execution.undecodable_reasons:
        for reason in execution.undecodable_reasons:
            all_citation_failures.append({"error": reason})

    validated_by_step: dict[int, list[ValidatedEvidenceItem]] = {}
    global_item_idx = 0
    for step_idx, step in enumerate(execution.all_steps):
        if not isinstance(step, CompletedStep):
            continue
        step_valid_items: list[ValidatedEvidenceItem] = []
        for pos, item in enumerate(step.items):
            validated_item, errs = validate_returned_item(item, corpus, item_index=global_item_idx)
            global_item_idx += 1
            all_citation_failures.extend(errs)
            if validated_item is not None and not errs:
                if step.step_name != "search" or pos < top_k:
                    step_valid_items.append(validated_item)
        validated_by_step[step_idx] = step_valid_items

    credited_items: list[ValidatedEvidenceItem] = []
    credited_search_hits_count = 0
    cumulative_credited_bytes = 0
    budget_exceeded = False
    budget_stopped = False

    for step_idx, step in enumerate(execution.all_steps):
        per_call_cap = (
            stdout_byte_budget
            if step.step_name == "search"
            else (read_byte_budget if read_byte_budget is not None else stdout_byte_budget)
        )
        if budget_stopped:
            continue
        exceeds_call = per_call_cap is not None and step.stdout_bytes > per_call_cap
        exceeds_cum = (
            cumulative_stdout_byte_budget is not None
            and cumulative_credited_bytes + step.stdout_bytes > cumulative_stdout_byte_budget
        )
        if exceeds_call or exceeds_cum:
            budget_exceeded = True
            budget_stopped = True
            continue
        cumulative_credited_bytes += step.stdout_bytes
        if isinstance(step, CompletedStep):
            step_valid_items = validated_by_step[step_idx]
            credited_items.extend(step_valid_items)
            if step.step_name == "search":
                credited_search_hits_count += len(step_valid_items)

    cumulative_observed_stdout_bytes = execution.search_stdout_bytes + execution.read_stdout_bytes
    citation_ok = len(all_citation_failures) == 0

    if isinstance(execution, NonScoreableExecution):
        return _null_outcome_row(
            question,
            outcome_schema_version=OUTCOME_SCHEMA_VERSION,
            outcome_version_valid=True,
            status=execution.status,
            stop_reason=execution.stop_reason,
            top_k=top_k,
            stdout_byte_budget=stdout_byte_budget,
            read_byte_budget=read_byte_budget,
            cumulative_stdout_byte_budget=cumulative_stdout_byte_budget,
            search_stdout_bytes=execution.search_stdout_bytes,
            read_stdout_bytes=execution.read_stdout_bytes,
            cumulative_stdout_bytes=cumulative_observed_stdout_bytes,
            stderr_bytes=execution.stderr_bytes,
            budget_exceeded=budget_exceeded,
            citation_ok=citation_ok,
            citation_failures=all_citation_failures,
            obligation_count=len(obligations),
            condition_count=len(cond_obs),
            counterexample_count=len(ce_obs),
        )

    if question["answerable"] is False:
        return {
            "id": question["id"],
            "category": question.get("category"),
            "answerable": False,
            "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
            "outcomeVersionValid": True,
            "status": "completed",
            "stopReason": None,
            "topK": top_k,
            "stdoutByteBudget": stdout_byte_budget,
            "readByteBudget": read_byte_budget,
            "cumulativeStdoutByteBudget": cumulative_stdout_byte_budget,
            "searchStdoutUtf8Bytes": execution.search_stdout_bytes,
            "readStdoutUtf8Bytes": execution.read_stdout_bytes,
            "cumulativeStdoutUtf8Bytes": cumulative_observed_stdout_bytes,
            "stderrUtf8Bytes": execution.stderr_bytes,
            "stdoutBudgetExceeded": budget_exceeded,
            "tokenBudget": None,
            "tokenMetricNote": "UTF-8 bytes are not tokens; token budget requires model tokenizer",
            "citationRawSpanValid": citation_ok,
            "citationFailures": all_citation_failures,
            "returnedHitCount": credited_search_hits_count,
            "evidenceCoverage": None,
            "completeChain": None,
            "unanswerableNote": "Irrelevant retrieval on unanswerable question is expected; insufficiency marking requires host eval.",
        }

    try:
        covered_obs = sum(
            1
            for ob_group in obligations
            if any(_item_covers_evidence(ev, credited_items, corpus) for ev in ob_group)
        )
        cond_cov = sum(
            1
            for ob in cond_obs
            if any(_item_covers_evidence(ev, credited_items, corpus) for ev in ob)
        )
        ce_cov = sum(
            1
            for ob in ce_obs
            if any(_item_covers_evidence(ev, credited_items, corpus) for ev in ob)
        )
    except ProjectionVerificationError as exc:
        return _null_outcome_row(
            question,
            outcome_schema_version=OUTCOME_SCHEMA_VERSION,
            outcome_version_valid=True,
            status="inconclusive",
            stop_reason=f"projection_error:{exc}",
            top_k=top_k,
            stdout_byte_budget=stdout_byte_budget,
            read_byte_budget=read_byte_budget,
            cumulative_stdout_byte_budget=cumulative_stdout_byte_budget,
            search_stdout_bytes=execution.search_stdout_bytes,
            read_stdout_bytes=execution.read_stdout_bytes,
            cumulative_stdout_bytes=cumulative_observed_stdout_bytes,
            stderr_bytes=execution.stderr_bytes,
            budget_exceeded=budget_exceeded,
            citation_ok=False,
            citation_failures=[*all_citation_failures, {"error": f"projection_error:{exc}"}],
            obligation_count=len(obligations),
            condition_count=len(cond_obs),
            counterexample_count=len(ce_obs),
        )

    complete_chain = (
        bool(obligations)
        and covered_obs == len(obligations)
        and citation_ok
        and not budget_exceeded
    )
    coverage = (covered_obs / len(obligations)) if obligations else None

    return {
        "id": question["id"],
        "category": question.get("category"),
        "answerable": True,
        "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
        "outcomeVersionValid": True,
        "status": "completed",
        "stopReason": None,
        "topK": top_k,
        "stdoutByteBudget": stdout_byte_budget,
        "readByteBudget": read_byte_budget,
        "cumulativeStdoutByteBudget": cumulative_stdout_byte_budget,
        "searchStdoutUtf8Bytes": execution.search_stdout_bytes,
        "readStdoutUtf8Bytes": execution.read_stdout_bytes,
        "cumulativeStdoutUtf8Bytes": cumulative_observed_stdout_bytes,
        "stderrUtf8Bytes": execution.stderr_bytes,
        "stdoutBudgetExceeded": budget_exceeded,
        "tokenBudget": None,
        "tokenMetricNote": "UTF-8 bytes are not tokens; token budget requires model tokenizer",
        "citationRawSpanValid": citation_ok,
        "citationFailures": all_citation_failures,
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
    cumulative_stdout_byte_budget: int | None = None,
) -> dict[str, Any]:
    gt_errors = validate_dataset_against_db(dataset, corpus, active_release_sha256)
    if gt_errors:
        return {
            "schemaVersion": 1,
            "verdict": "inconclusive",
            "reason": "Ground truth validation failed or dataset corpusSha256 mismatched active corpus.",
            "groundTruthValidation": {"valid": False, "errorCount": len(gt_errors), "errors": gt_errors},
            "corpusSha256": active_release_sha256,
            "actualCorpusSha256": corpus.actual_sha256,
            "corpusFormat": corpus.corpus_format,
            "split": dataset.get("split"),
            "perQuestion": [],
        }

    if not isinstance(outcomes, list):
        return {
            "schemaVersion": 1,
            "verdict": "inconclusive",
            "reason": "Outcomes payload must be a JSON list of outcomeSchemaVersion=2 records.",
            "corpusSha256": active_release_sha256,
            "actualCorpusSha256": corpus.actual_sha256,
            "corpusFormat": corpus.corpus_format,
            "split": dataset.get("split"),
            "perQuestion": [],
        }

    questions = dataset["questions"]
    outcomes_by_id: dict[str, dict[str, Any]] = {}
    for o in outcomes:
        if not isinstance(o, dict) or not isinstance(o.get("id"), str) or not o["id"]:
            return {
                "schemaVersion": 1,
                "verdict": "inconclusive",
                "reason": "Outcome entry missing string id or object shape.",
                "corpusSha256": active_release_sha256,
                "actualCorpusSha256": corpus.actual_sha256,
                "corpusFormat": corpus.corpus_format,
                "split": dataset.get("split"),
                "perQuestion": [],
            }
        if o["id"] in outcomes_by_id:
            return {
                "schemaVersion": 1,
                "verdict": "inconclusive",
                "reason": f"Duplicate outcome id {o['id']!r}.",
                "corpusSha256": active_release_sha256,
                "actualCorpusSha256": corpus.actual_sha256,
                "corpusFormat": corpus.corpus_format,
                "split": dataset.get("split"),
                "perQuestion": [],
            }
        v2_ok, v2_err = _is_valid_v2_outcome(o)
        if not v2_ok:
            return {
                "schemaVersion": 1,
                "verdict": "inconclusive",
                "reason": f"Unsupported or invalid outcome for {o.get('id')!r}: {v2_err}",
                "corpusSha256": active_release_sha256,
                "actualCorpusSha256": corpus.actual_sha256,
                "corpusFormat": corpus.corpus_format,
                "split": dataset.get("split"),
                "perQuestion": [],
            }
        outcomes_by_id[o["id"]] = o

    per_question: list[dict[str, Any]] = []
    for q in questions:
        outcome = outcomes_by_id.get(
            q["id"],
            {
                "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
                "id": q["id"],
                "status": "error",
                "stopReason": "missing_outcome",
                "steps": [],
            },
        )
        per_question.append(
            score_question(
                q,
                outcome,
                corpus,
                top_k=top_k,
                stdout_byte_budget=stdout_byte_budget,
                read_byte_budget=read_byte_budget,
                cumulative_stdout_byte_budget=cumulative_stdout_byte_budget,
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
    budget_violation_count = sum(1 for r in per_question if r["stdoutBudgetExceeded"] is True)
    total_conditions = sum(r.get("conditionCount", 0) for r in answerable_rows)
    total_conditions_covered = sum(r.get("conditionsCovered") or 0 for r in completed_answerable)
    total_counterexamples = sum(r.get("counterexampleCount", 0) for r in answerable_rows)
    total_counterexamples_covered = sum(r.get("counterexamplesCovered") or 0 for r in completed_answerable)

    gates = {
        "groundTruthValid": True,
        "corpusSha256Verified": corpus.actual_sha256 == active_release_sha256,
        "outcomeSchemaV2Valid": all(r["outcomeVersionValid"] is True for r in per_question),
        "zeroRawQuoteFabricationOrWrongRange": citation_valid_count == len(per_question),
        "zeroErrorsInDenominator": len(error_rows) == 0,
        "zeroBudgetViolations": budget_violation_count == 0,
        "zeroCriticalConditionLoss": total_conditions == total_conditions_covered
        and total_counterexamples == total_counterexamples_covered,
    }

    return {
        "schemaVersion": 1,
        "verdict": "complete" if len(error_rows) == 0 else "inconclusive_errors_present",
        "groundTruthValidation": {"valid": True, "errorCount": 0, "errors": []},
        "corpusSha256": active_release_sha256,
        "actualCorpusSha256": corpus.actual_sha256,
        "corpusFormat": corpus.corpus_format,
        "split": dataset["split"],
        "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
        "topK": top_k,
        "stdoutByteBudget": stdout_byte_budget,
        "readByteBudget": read_byte_budget,
        "cumulativeStdoutByteBudget": cumulative_stdout_byte_budget,
        "counts": {
            "scheduledQuestions": len(per_question),
            "answerableQuestions": len(answerable_rows),
            "unanswerableQuestions": len(unanswerable_rows),
            "completedAnswerable": len(completed_answerable),
            "errorsOrTimeouts": len(error_rows),
            "budgetViolations": budget_violation_count,
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
