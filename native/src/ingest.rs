use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::domain::{BoundaryKind, ByteSpan, ClecError, ErrorCode, SourceRole};

pub const TARGET_MIN_SCALARS: usize = 1000;
pub const TARGET_MAX_SCALARS: usize = 1200;
pub const HARD_MAX_SCALARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    pub ordinal: usize,
    pub original_identifier: Option<String>,
    pub raw_start_byte: usize,
    pub raw_end_byte: usize,
    pub text_start_byte: usize,
    pub text_end_byte: usize,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ExtractionResult {
    pub text: String,
    pub is_subtitle: bool,
    pub cues: Vec<SubtitleCue>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DraftPassage {
    pub ordinal: usize,
    pub boundary: BoundaryKind,
    pub is_continuation: bool,
    pub spans: Vec<ByteSpan>,
    pub text: String,
}

pub fn is_subtitle_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "srt" | "str" | "vtt"))
}

pub fn is_supported_text_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "md" | "txt" | "srt" | "str" | "vtt"
            )
        })
}

pub fn extract_source(raw_bytes: &[u8], is_subtitle: bool) -> Result<ExtractionResult, ClecError> {
    let text = std::str::from_utf8(raw_bytes)
        .map_err(|_| ClecError::new(ErrorCode::InvalidPackage, "Source is not valid UTF-8."))?
        .to_owned();

    if !is_subtitle {
        return Ok(ExtractionResult {
            text,
            is_subtitle: false,
            cues: Vec::new(),
            diagnostics: Vec::new(),
        });
    }

    let (cues, diagnostics) = parse_subtitle_cues(&text);
    Ok(ExtractionResult {
        text,
        is_subtitle: true,
        cues,
        diagnostics,
    })
}

#[derive(Debug, Clone, Copy)]
struct LineSlice<'a> {
    start_byte: usize,
    raw: &'a str,
    trimmed: &'a str,
}

fn split_lines_with_offsets(text: &str) -> Vec<LineSlice<'_>> {
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() {
        let line_start = pos;
        while pos < bytes.len() && bytes[pos] != b'\n' && bytes[pos] != b'\r' {
            pos += 1;
        }
        let content_end = pos;
        if pos < bytes.len() {
            if bytes[pos] == b'\r' && pos + 1 < bytes.len() && bytes[pos + 1] == b'\n' {
                pos += 2;
            } else {
                pos += 1;
            }
        }
        let raw = &text[line_start..pos];
        let content = &text[line_start..content_end];
        let trimmed = content.trim_start_matches('\u{FEFF}').trim();
        lines.push(LineSlice {
            start_byte: line_start,
            raw,
            trimmed,
        });
    }
    lines
}

fn parse_timestamp_ms(token: &str) -> Option<u64> {
    let normalized = token.replace(',', ".");
    let (hms, ms_str) = normalized.split_once('.')?;
    if ms_str.len() != 3 || !ms_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ms: u64 = ms_str.parse().ok()?;
    let parts: Vec<&str> = hms.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [m, s] => (0u64, m.parse::<u64>().ok()?, s.parse::<u64>().ok()?),
        [h, m, s] => (
            h.parse::<u64>().ok()?,
            m.parse::<u64>().ok()?,
            s.parse::<u64>().ok()?,
        ),
        _ => return None,
    };
    if minutes >= 60 || seconds >= 60 {
        return None;
    }
    Some(((hours * 3600) + (minutes * 60) + seconds) * 1000 + ms)
}

fn parse_timing_line(trimmed: &str) -> Option<Result<(u64, u64), &'static str>> {
    if !trimmed.contains("-->") {
        return None;
    }
    let (left, right_all) = trimmed.split_once("-->")?;
    let start_tok = left.trim();
    let end_tok = right_all.split_whitespace().next().unwrap_or("").trim();
    if start_tok.is_empty() || end_tok.is_empty() {
        return Some(Err("malformed"));
    }
    let Some(start_ms) = parse_timestamp_ms(start_tok) else {
        return Some(Err("invalid_ts"));
    };
    let Some(end_ms) = parse_timestamp_ms(end_tok) else {
        return Some(Err("invalid_ts"));
    };
    Some(Ok((start_ms, end_ms)))
}

fn is_vtt_block_header(trimmed: &str) -> bool {
    trimmed == "NOTE"
        || trimmed.starts_with("NOTE ")
        || trimmed.starts_with("NOTE\t")
        || trimmed == "STYLE"
        || trimmed == "REGION"
}

fn trim_trailing_eol_len(raw: &str) -> usize {
    raw.trim_end_matches(['\r', '\n']).len()
}

fn parse_subtitle_cues(text: &str) -> (Vec<SubtitleCue>, Vec<String>) {
    let lines = split_lines_with_offsets(text);
    let mut cues = Vec::new();
    let mut diagnostics = Vec::new();
    let mut last_payload_line: Option<usize> = None;
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        if is_vtt_block_header(line.trimmed) {
            while i + 1 < lines.len() && !lines[i + 1].trimmed.is_empty() {
                i += 1;
            }
            i += 1;
            continue;
        }

        let Some(timing_res) = parse_timing_line(line.trimmed) else {
            i += 1;
            continue;
        };

        let (start_ms, end_ms) = match timing_res {
            Ok(times) => times,
            Err("invalid_ts") => {
                diagnostics.push(format!(
                    "Invalid timestamp at UTF-8 byte {}.",
                    line.start_byte
                ));
                i += 1;
                continue;
            }
            Err(_) => {
                diagnostics.push(format!(
                    "Malformed timing at UTF-8 byte {}.",
                    line.start_byte
                ));
                i += 1;
                continue;
            }
        };

        let mut stop = i + 1;
        while stop < lines.len()
            && !lines[stop].trimmed.is_empty()
            && !lines[stop].trimmed.contains("-->")
        {
            stop += 1;
        }

        let mut payload_stop = stop;
        if stop < lines.len() && lines[stop].trimmed.contains("-->") {
            diagnostics.push(format!(
                "Missing cue separator before timing at UTF-8 byte {}.",
                lines[stop].start_byte
            ));
            if payload_stop > i + 1
                && lines[payload_stop - 1]
                    .trimmed
                    .bytes()
                    .all(|b| b.is_ascii_digit())
            {
                payload_stop -= 1;
            }
        }

        if payload_stop <= i + 1 || end_ms < start_ms {
            diagnostics.push(format!(
                "Empty or reversed cue at UTF-8 byte {}.",
                line.start_byte
            ));
            i = stop;
            continue;
        }

        let first = lines[i + 1];
        let last = lines[payload_stop - 1];
        let text_start_byte = first.start_byte;
        let text_end_byte = last.start_byte + trim_trailing_eol_len(last.raw);
        if text_start_byte >= text_end_byte {
            diagnostics.push(format!(
                "Empty cue payload at UTF-8 byte {}.",
                line.start_byte
            ));
            i = stop;
            continue;
        }

        let mut original_identifier = None;
        let mut raw_start_byte = line.start_byte;
        if i > 0 {
            let prev_idx = i - 1;
            let after_last_payload = last_payload_line.is_none_or(|prev| prev_idx > prev);
            let prev = lines[prev_idx];
            if after_last_payload
                && !prev.trimmed.is_empty()
                && !prev.trimmed.contains("-->")
                && prev.trimmed != "WEBVTT"
                && !prev.trimmed.starts_with("NOTE")
            {
                original_identifier = Some(prev.trimmed.to_owned());
                raw_start_byte = prev.start_byte;
            }
        }

        let raw_end_byte = last.start_byte + last.raw.len();
        cues.push(SubtitleCue {
            ordinal: cues.len(),
            original_identifier,
            raw_start_byte,
            raw_end_byte,
            text_start_byte,
            text_end_byte,
            start_ms,
            end_ms,
        });
        last_payload_line = Some(payload_stop - 1);
        i = stop;
    }

    if cues.is_empty() {
        diagnostics.push("No usable subtitle cues.".to_owned());
    }
    (cues, diagnostics)
}

pub fn reconstruct_passage_text(raw_bytes: &[u8], spans: &[ByteSpan]) -> Result<String, ClecError> {
    if spans.is_empty() {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Passage must have at least one byte span.",
        ));
    }
    let mut parts = Vec::with_capacity(spans.len());
    for span in spans {
        if span.end_byte > raw_bytes.len() || span.start_byte >= span.end_byte {
            return Err(ClecError::new(
                ErrorCode::IntegrityMismatch,
                "Passage byte span is out of bounds for source bytes.",
            ));
        }
        let slice =
            std::str::from_utf8(&raw_bytes[span.start_byte..span.end_byte]).map_err(|_| {
                ClecError::new(
                    ErrorCode::IntegrityMismatch,
                    "Passage byte span does not align on UTF-8 boundaries.",
                )
            })?;
        parts.push(slice);
    }
    Ok(parts.join("\n"))
}

pub fn segment_source(
    extraction: &ExtractionResult,
    role: SourceRole,
) -> Result<Vec<DraftPassage>, ClecError> {
    if extraction.is_subtitle {
        segment_subtitle_cues(&extraction.text, &extraction.cues)
    } else {
        segment_plain_text(&extraction.text, role)
    }
}

fn segment_subtitle_cues(text: &str, cues: &[SubtitleCue]) -> Result<Vec<DraftPassage>, ClecError> {
    if cues.is_empty() {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Cannot segment subtitle source with zero cues.",
        ));
    }

    let cue_texts: Vec<(&SubtitleCue, &str, usize)> = cues
        .iter()
        .map(|cue| {
            let s = &text[cue.text_start_byte..cue.text_end_byte];
            let scalars = s.chars().count();
            (cue, s, scalars)
        })
        .collect();

    let total_scalars: usize =
        cue_texts.iter().map(|(_, _, n)| *n).sum::<usize>() + cue_texts.len().saturating_sub(1);

    if total_scalars <= TARGET_MAX_SCALARS {
        let mut spans = Vec::with_capacity(cue_texts.len());
        let mut joined = Vec::with_capacity(cue_texts.len());
        for (cue, s, _) in cue_texts {
            spans.push(ByteSpan::new(
                cue.text_start_byte,
                cue.text_end_byte,
                Some(cue.ordinal),
            )?);
            joined.push(s);
        }
        return Ok(vec![DraftPassage {
            ordinal: 0,
            boundary: BoundaryKind::Whole,
            is_continuation: false,
            spans,
            text: joined.join("\n"),
        }]);
    }

    let mut passages = Vec::new();
    let mut current_spans: Vec<ByteSpan> = Vec::new();
    let mut current_parts: Vec<&str> = Vec::new();
    let mut current_scalars: usize = 0;

    let flush = |passages: &mut Vec<DraftPassage>,
                 spans: &mut Vec<ByteSpan>,
                 parts: &mut Vec<&str>,
                 scalars: &mut usize,
                 boundary: BoundaryKind,
                 is_cont: bool| {
        if spans.is_empty() {
            return;
        }
        passages.push(DraftPassage {
            ordinal: passages.len(),
            boundary,
            is_continuation: is_cont,
            spans: std::mem::take(spans),
            text: std::mem::take(parts).join("\n"),
        });
        *scalars = 0;
    };

    for (cue, cue_str, cue_scalars) in cue_texts {
        if cue_scalars > HARD_MAX_SCALARS {
            let cont = !current_spans.is_empty();
            flush(
                &mut passages,
                &mut current_spans,
                &mut current_parts,
                &mut current_scalars,
                BoundaryKind::CueGroup,
                false,
            );
            let mut local_start = 0usize;
            let mut first_slice = !cont;
            while local_start < cue_str.len() {
                let slice_end = advance_scalars_byte(cue_str, local_start, HARD_MAX_SCALARS);
                let abs_start = cue.text_start_byte + local_start;
                let abs_end = cue.text_start_byte + slice_end;
                let span = ByteSpan::new(abs_start, abs_end, Some(cue.ordinal))?;
                passages.push(DraftPassage {
                    ordinal: passages.len(),
                    boundary: BoundaryKind::HardCut,
                    is_continuation: !first_slice,
                    spans: vec![span],
                    text: cue_str[local_start..slice_end].to_owned(),
                });
                first_slice = false;
                local_start = slice_end;
            }
            continue;
        }

        let added = if current_spans.is_empty() {
            cue_scalars
        } else {
            cue_scalars + 1
        };

        let should_flush = !current_spans.is_empty()
            && ((current_scalars >= TARGET_MIN_SCALARS
                && current_scalars + added > TARGET_MAX_SCALARS)
                || current_scalars + added > HARD_MAX_SCALARS);

        if should_flush {
            flush(
                &mut passages,
                &mut current_spans,
                &mut current_parts,
                &mut current_scalars,
                BoundaryKind::CueGroup,
                false,
            );
        }

        current_spans.push(ByteSpan::new(
            cue.text_start_byte,
            cue.text_end_byte,
            Some(cue.ordinal),
        )?);
        current_parts.push(cue_str);
        current_scalars += if current_parts.len() == 1 {
            cue_scalars
        } else {
            cue_scalars + 1
        };
    }

    flush(
        &mut passages,
        &mut current_spans,
        &mut current_parts,
        &mut current_scalars,
        BoundaryKind::CueGroup,
        false,
    );

    Ok(passages)
}

fn advance_scalars_byte(text: &str, start: usize, max_scalars: usize) -> usize {
    let slice = &text[start..];
    for (count, (idx, _)) in slice.char_indices().enumerate() {
        if count == max_scalars {
            return start + idx;
        }
    }
    text.len()
}

fn is_qa_line_start(line: &str) -> bool {
    let trimmed = line.trim_start_matches([' ', '\t', '#']).trim_start();
    const PREFIXES: &[&str] = &[
        "Q:",
        "Q：",
        "A:",
        "A：",
        "問:",
        "問：",
        "答:",
        "答：",
        "問題:",
        "問題：",
        "问题:",
        "问题：",
        "回答:",
        "回答：",
        "答案:",
        "答案：",
        "以下是來信",
        "以下是老師的回覆",
        "以下是老师的回复",
        "來信內容",
        "来信内容",
        "老師回覆",
        "老师回复",
    ];
    PREFIXES.iter().any(|p| trimmed.starts_with(p))
}

#[derive(Debug, Clone, Copy)]
struct CandidateCut {
    byte_offset: usize,
    scalar_offset: usize,
    kind: BoundaryKind,
}

fn collect_candidates(window: &str, role: SourceRole) -> Vec<CandidateCut> {
    let mut cuts = Vec::new();
    let mut scalar_idx = 0usize;
    let mut chars = window.char_indices().peekable();
    let mut at_line_start = true;

    while let Some((byte_idx, ch)) = chars.next() {
        if at_line_start && byte_idx > 0 {
            let rest = &window[byte_idx..];
            let line_end = rest.find(['\n', '\r']).unwrap_or(rest.len());
            let line = &rest[..line_end];
            if (role == SourceRole::Qa || role == SourceRole::Transcript) && is_qa_line_start(line)
            {
                cuts.push(CandidateCut {
                    byte_offset: byte_idx,
                    scalar_offset: scalar_idx,
                    kind: BoundaryKind::Qa,
                });
            } else if line.starts_with('#') {
                cuts.push(CandidateCut {
                    byte_offset: byte_idx,
                    scalar_offset: scalar_idx,
                    kind: BoundaryKind::Paragraph,
                });
            }
        }

        let next_byte = byte_idx + ch.len_utf8();
        let next_scalar = scalar_idx + 1;

        if ch == '\n' {
            let is_blank_next =
                window[next_byte..].starts_with('\n') || window[next_byte..].starts_with("\r\n");
            if is_blank_next {
                let para_end = if window[next_byte..].starts_with("\r\n") {
                    next_byte + 2
                } else {
                    next_byte + 1
                };
                let para_scalars = next_scalar
                    + if window[next_byte..].starts_with("\r\n") {
                        2
                    } else {
                        1
                    };
                cuts.push(CandidateCut {
                    byte_offset: para_end,
                    scalar_offset: para_scalars,
                    kind: BoundaryKind::Paragraph,
                });
            } else {
                cuts.push(CandidateCut {
                    byte_offset: next_byte,
                    scalar_offset: next_scalar,
                    kind: BoundaryKind::Sentence,
                });
            }
            at_line_start = true;
        } else if matches!(ch, '。' | '！' | '？')
            || (matches!(ch, '.' | '!' | '?')
                && chars.peek().is_some_and(|(_, next)| next.is_whitespace()))
        {
            cuts.push(CandidateCut {
                byte_offset: next_byte,
                scalar_offset: next_scalar,
                kind: BoundaryKind::Sentence,
            });
            at_line_start = false;
        } else {
            at_line_start = false;
        }

        scalar_idx = next_scalar;
    }
    cuts
}

fn pick_best_cut(window: &str, role: SourceRole) -> (usize, BoundaryKind) {
    let candidates = collect_candidates(window, role);
    let score = |c: &CandidateCut| -> (u8, u8, usize) {
        let band = if (TARGET_MIN_SCALARS..=TARGET_MAX_SCALARS).contains(&c.scalar_offset) {
            3
        } else if c.scalar_offset >= 500 && c.scalar_offset < TARGET_MIN_SCALARS {
            2
        } else if c.scalar_offset > TARGET_MAX_SCALARS {
            1
        } else {
            0
        };
        let prio = match c.kind {
            BoundaryKind::Qa => 3,
            BoundaryKind::Paragraph => 2,
            BoundaryKind::Sentence => 1,
            BoundaryKind::Whole | BoundaryKind::CueGroup | BoundaryKind::HardCut => 0,
        };
        let target_mid = (TARGET_MIN_SCALARS + TARGET_MAX_SCALARS) / 2;
        let closeness = usize::MAX - c.scalar_offset.abs_diff(target_mid);
        (band, prio, closeness)
    };

    if let Some(best) = candidates
        .iter()
        .filter(|c| c.byte_offset > 0 && c.byte_offset < window.len() && c.scalar_offset >= 100)
        .max_by_key(|c| score(c))
    {
        return (best.byte_offset, best.kind);
    }

    (window.len(), BoundaryKind::HardCut)
}

fn segment_plain_text(text: &str, role: SourceRole) -> Result<Vec<DraftPassage>, ClecError> {
    if text.trim().is_empty() {
        return Err(ClecError::new(
            ErrorCode::InvalidPackage,
            "Cannot segment empty text source.",
        ));
    }

    let total_scalars = text.chars().count();
    if total_scalars <= TARGET_MAX_SCALARS {
        let span = ByteSpan::new(0, text.len(), None)?;
        return Ok(vec![DraftPassage {
            ordinal: 0,
            boundary: BoundaryKind::Whole,
            is_continuation: false,
            spans: vec![span],
            text: text.to_owned(),
        }]);
    }

    let mut passages = Vec::new();
    let mut start = 0usize;
    let mut prev_was_hard_or_mid = false;

    while start < text.len() {
        let remaining_scalars = text[start..].chars().count();
        if remaining_scalars <= TARGET_MAX_SCALARS {
            let span = ByteSpan::new(start, text.len(), None)?;
            passages.push(DraftPassage {
                ordinal: passages.len(),
                boundary: BoundaryKind::Paragraph,
                is_continuation: prev_was_hard_or_mid,
                spans: vec![span],
                text: text[start..].to_owned(),
            });
            break;
        }

        let hard_end = advance_scalars_byte(text, start, HARD_MAX_SCALARS);
        let window = &text[start..hard_end];
        let (rel_cut, boundary) = pick_best_cut(window, role);
        let end = start + rel_cut;
        let span = ByteSpan::new(start, end, None)?;
        passages.push(DraftPassage {
            ordinal: passages.len(),
            boundary,
            is_continuation: prev_was_hard_or_mid,
            spans: vec![span],
            text: text[start..end].to_owned(),
        });
        prev_was_hard_or_mid = boundary == BoundaryKind::HardCut;
        start = end;
    }

    Ok(passages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtitle_parser_preserves_bom_crlf_emoji_overlaps_and_diagnostics() {
        let raw = "\u{FEFF}WEBVTT\r\n\r\nNOTE ignored\r\n00:00.000 --> 00:01.000\r\nnot a cue\r\n\r\nid\r\n00:01.000 --> 00:03.000 position:10%\r\n<b>退休😀</b>\r\n第二行\r\n\r\nid\r\n00:02.000 --> 00:04.000\r\n重疊\r\n\r\n00:99.000 --> 00:01.000\r\n錯誤\r\n";
        let ext = extract_source(raw.as_bytes(), true).unwrap();
        assert_eq!(ext.cues.len(), 2);
        assert_eq!(ext.cues[0].original_identifier.as_deref(), Some("id"));
        assert_eq!(
            &raw[ext.cues[0].text_start_byte..ext.cues[0].text_end_byte],
            "<b>退休😀</b>\r\n第二行"
        );
        assert_eq!(ext.cues[1].start_ms, 2000);
        assert_eq!(ext.cues[1].end_ms, 4000);
        assert!(!ext.diagnostics.is_empty());

        let missing_sep =
            "1\n00:00:01,000 --> 00:00:02,000\n第一句\n2\n00:00:02,000 --> 00:00:03,000\n第二句\n";
        let ext2 = extract_source(missing_sep.as_bytes(), true).unwrap();
        assert_eq!(ext2.cues.len(), 2);
        assert_eq!(ext2.cues[1].original_identifier.as_deref(), Some("2"));
        assert_eq!(
            &missing_sep[ext2.cues[0].text_start_byte..ext2.cues[0].text_end_byte],
            "第一句"
        );
        assert!(ext2.diagnostics.iter().any(|d| d.contains("separator")));
    }

    #[test]
    fn unpunctuated_asr_hard_cuts_within_2000_scalars_and_links_continuations() {
        let long_asr = "退".repeat(4500);
        let ext = extract_source(long_asr.as_bytes(), false).unwrap();
        let passages = segment_source(&ext, SourceRole::Transcript).unwrap();
        assert_eq!(passages.len(), 3);
        assert_eq!(passages[0].text.chars().count(), 2000);
        assert_eq!(passages[1].text.chars().count(), 2000);
        assert_eq!(passages[2].text.chars().count(), 500);
        assert_eq!(passages[0].boundary, BoundaryKind::HardCut);
        assert!(!passages[0].is_continuation);
        assert!(passages[1].is_continuation);
        assert!(passages[2].is_continuation);
        for p in &passages {
            assert_eq!(
                reconstruct_passage_text(long_asr.as_bytes(), &p.spans).unwrap(),
                p.text
            );
        }
    }

    #[test]
    fn subtitle_cues_combine_into_passages_with_span_lists() {
        let mut srt = String::new();
        for idx in 1..=80 {
            let chunk = "甲".repeat(30);
            srt.push_str(&format!(
                "{idx}\n00:00:{:02},000 --> 00:00:{:02},500\n{chunk}\n\n",
                idx % 59,
                (idx % 59) + 1
            ));
        }
        let ext = extract_source(srt.as_bytes(), true).unwrap();
        let passages = segment_source(&ext, SourceRole::Transcript).unwrap();
        assert!(passages.len() >= 2);
        for p in &passages {
            let count = p.text.chars().count();
            assert!(count <= HARD_MAX_SCALARS);
            assert!(p.spans.len() > 1);
            assert_eq!(
                reconstruct_passage_text(srt.as_bytes(), &p.spans).unwrap(),
                p.text
            );
        }
    }
}
