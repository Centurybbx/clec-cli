"""Exact character-range projection under clec-native-v2 equiv-v1 Unicode whitespace folding."""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
import hashlib
from typing import Sequence


VALID_PROJECTION_KINDS = frozenset(
    {"subtitle_cue_payload", "archive_voice_note_md", "plain_text"}
)
# Matches Rust char::is_whitespace (Unicode White_Space=Y), excluding U+001C..U+001F.
RUST_WHITESPACE_CHARS = frozenset(
    "\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0"
    "\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
)
_RUST_WHITESPACE_STR = "".join(RUST_WHITESPACE_CHARS)
_I64_MAX = (1 << 63) - 1


def _rust_trim(text: str) -> str:
    return text.strip(_RUST_WHITESPACE_STR)


def _parse_ascii_uint(part: str) -> int | None:
    if not part or not part.isascii() or not part.isdigit():
        return None
    return int(part)


def _parse_timestamp_ms(token: str) -> int | None:
    normalized = token.replace(",", ".")
    if "." not in normalized:
        return None
    hms, ms_str = normalized.split(".", 1)
    if len(ms_str) != 3 or not ms_str.isascii() or not ms_str.isdigit():
        return None
    ms = int(ms_str)
    parts = hms.split(":")
    if len(parts) == 2:
        hours = 0
        minutes = _parse_ascii_uint(parts[0])
        seconds = _parse_ascii_uint(parts[1])
    elif len(parts) == 3:
        hours = _parse_ascii_uint(parts[0])
        minutes = _parse_ascii_uint(parts[1])
        seconds = _parse_ascii_uint(parts[2])
    else:
        return None
    if hours is None or minutes is None or seconds is None:
        return None
    if minutes >= 60 or seconds >= 60:
        return None
    total_ms = ((hours * 3600) + (minutes * 60) + seconds) * 1000 + ms
    if total_ms > _I64_MAX:
        return None
    return total_ms


def _is_archive_md_ts_header(trimmed: str) -> bool:
    if not (trimmed.startswith("## [") and trimmed.endswith("]")):
        return False
    inner = trimmed[4:-1]
    if " – " in inner:
        left, right = inner.split(" – ", 1)
    elif " - " in inner:
        left, right = inner.split(" - ", 1)
    else:
        return False
    return (
        _parse_timestamp_ms(_rust_trim(left)) is not None
        and _parse_timestamp_ms(_rust_trim(right)) is not None
    )


def _rust_lines_with_byte_offsets(
    raw_bytes: bytes, start_offset: int
) -> list[tuple[int, int, str]]:
    lines: list[tuple[int, int, str]] = []
    pos = start_offset
    total = len(raw_bytes)
    while pos < total:
        nl = raw_bytes.find(b"\n", pos)
        if nl == -1:
            content = raw_bytes[pos:total].decode("utf-8", errors="strict")
            lines.append((pos, total, content))
            break
        content_end = nl - 1 if nl > pos and raw_bytes[nl - 1] == 0x0D else nl
        content = raw_bytes[pos:content_end].decode("utf-8", errors="strict")
        lines.append((pos, nl + 1, content))
        pos = nl + 1
    return lines


def merge_intervals(intervals: Sequence[tuple[int, int]]) -> list[tuple[int, int]]:
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


def intervals_cover(
    covering: Sequence[tuple[int, int]], target: tuple[int, int]
) -> bool:
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


def _is_valid_utf8_boundary(raw_bytes: bytes, pos: int) -> bool:
    if pos < 0 or pos > len(raw_bytes):
        return False
    if pos == 0 or pos == len(raw_bytes):
        return True
    return (raw_bytes[pos] & 0xC0) != 0x80


def validate_utf8_byte_range(
    raw_bytes: bytes, start_byte: int, end_byte: int
) -> tuple[int, int]:
    if (
        isinstance(start_byte, bool)
        or isinstance(end_byte, bool)
        or not isinstance(start_byte, int)
        or not isinstance(end_byte, int)
    ):
        raise ValueError(f"Byte range bounds must be integers: {(start_byte, end_byte)!r}")
    if start_byte < 0 or start_byte >= end_byte or end_byte > len(raw_bytes):
        raise ValueError(
            f"Byte range ({start_byte}, {end_byte}) out of bounds for {len(raw_bytes)} bytes"
        )
    if not _is_valid_utf8_boundary(raw_bytes, start_byte) or not _is_valid_utf8_boundary(
        raw_bytes, end_byte
    ):
        raise ValueError(
            f"Byte range ({start_byte}, {end_byte}) splits a UTF-8 codepoint"
        )
    return start_byte, end_byte


@dataclass(frozen=True)
class ProjectedSource:
    projection_kind: str
    canonical_text: str
    equivalence_hash: str
    raw_bytes: bytes
    char_starts: tuple[int, ...]
    char_ends: tuple[int, ...]

    def project_byte_spans(
        self, byte_spans: Sequence[tuple[int, int]]
    ) -> list[tuple[int, int]]:
        intervals: list[tuple[int, int]] = []
        for sb, eb in byte_spans:
            start_b, end_b = validate_utf8_byte_range(self.raw_bytes, sb, eb)
            first = bisect_left(self.char_starts, start_b)
            last = bisect_right(self.char_ends, end_b)
            if first < last:
                intervals.append((first, last))
        return merge_intervals(intervals)


def _extract_regions(
    raw_bytes: bytes,
    text: str,
    projection_kind: str,
    cues: Sequence[tuple[int, int]],
) -> list[tuple[int, int]]:
    if projection_kind == "subtitle_cue_payload":
        if not cues:
            raise ValueError("subtitle_cue_payload requires non-empty cue byte ranges")
        return [validate_utf8_byte_range(raw_bytes, int(s), int(e)) for s, e in cues]

    if projection_kind == "archive_voice_note_md":
        pos = 3 if raw_bytes.startswith(b"\xef\xbb\xbf") else 0
        lines = _rust_lines_with_byte_offsets(raw_bytes, pos)
        if not lines or not _rust_trim(lines[0][2]).startswith("# 語音筆記："):
            raise ValueError("archive_voice_note_md missing '# 語音筆記：' header")
        saw_ts_header = False
        regions: list[tuple[int, int]] = []
        for line_start, line_end, content in lines[1:]:
            trimmed = _rust_trim(content)
            if _is_archive_md_ts_header(trimmed):
                saw_ts_header = True
            elif trimmed:
                regions.append((line_start, line_end))
        if not saw_ts_header or not regions:
            raise ValueError("archive_voice_note_md missing timestamp headers or body")
        return regions

    if projection_kind == "plain_text":
        start_off = 3 if raw_bytes.startswith(b"\xef\xbb\xbf") else 0
        if start_off >= len(raw_bytes):
            raise ValueError("plain_text source has no body bytes after BOM")
        return [(start_off, len(raw_bytes))]

    raise ValueError(f"Unsupported projection_kind {projection_kind!r}")


def project_source(
    raw_bytes: bytes,
    projection_kind: str,
    cues: Sequence[tuple[int, int]] = (),
) -> ProjectedSource:
    if not isinstance(raw_bytes, (bytes, bytearray)):
        raise TypeError("raw_bytes must be bytes")
    raw = bytes(raw_bytes)
    text = raw.decode("utf-8", errors="strict")
    if projection_kind not in VALID_PROJECTION_KINDS:
        raise ValueError(f"Unsupported projection_kind {projection_kind!r}")

    regions = _extract_regions(raw, text, projection_kind, cues)
    char_starts: list[int] = []
    char_ends: list[int] = []
    tokens: list[str] = []

    for reg_start, reg_end in regions:
        reg_str = raw[reg_start:reg_end].decode("utf-8", errors="strict")
        byte_pos = reg_start
        cur_tok: list[str] = []
        for ch in reg_str:
            ch_bytes = len(ch.encode("utf-8"))
            if ch in RUST_WHITESPACE_CHARS:
                if cur_tok:
                    tokens.append("".join(cur_tok))
                    cur_tok.clear()
            else:
                char_starts.append(byte_pos)
                char_ends.append(byte_pos + ch_bytes)
                cur_tok.append(ch)
            byte_pos += ch_bytes
        if cur_tok:
            tokens.append("".join(cur_tok))

    if not tokens:
        raise ValueError("Projected canonical text is empty")

    canonical_text = " ".join(tokens)
    eq_hash = hashlib.sha256(f"equiv-v1:{canonical_text}".encode("utf-8")).hexdigest()
    return ProjectedSource(
        projection_kind=projection_kind,
        canonical_text=canonical_text,
        equivalence_hash=eq_hash,
        raw_bytes=raw,
        char_starts=tuple(char_starts),
        char_ends=tuple(char_ends),
    )
