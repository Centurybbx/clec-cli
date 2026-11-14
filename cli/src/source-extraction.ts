import { ClecError, hash, type Source } from "./contracts.js";
export interface SubtitleCue {
  ordinal: number;
  originalIdentifier: string | null;
  rawStart: number;
  rawEnd: number;
  textStart: number;
  textEnd: number;
  startMs: number;
  endMs: number;
  timeBasis: "subtitle-file";
}
export interface Extraction {
  text: string;
  encoding: string;
  cues: SubtitleCue[];
  diagnostics: string[];
}
export function extract(bytes: Buffer, subtitle: boolean): Extraction {
  const encoding = "utf-8";
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ClecError("INVALID_PACKAGE", "Invalid text encoding.");
  }
  if (!subtitle) return { text, encoding, cues: [], diagnostics: [] };
  const cues: SubtitleCue[] = [];
  const diagnostics: string[] = [];
  const timestamp = (input: string): number => {
    const parts = input.replace(",", ".").split(":").map(Number);
    return Math.round(parts.reduce((n, part) => n * 60 + part, 0) * 1000);
  };
  const lines = Array.from(text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)).filter(
    (m) => m[0],
  );
  let lastPayloadLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      /^(?:NOTE(?:[ \t].*)?|STYLE|REGION)$/.test(lines[i]?.[0].trim() ?? "")
    ) {
      while (i + 1 < lines.length && lines[i + 1]?.[0].trim()) i++;
      continue;
    }
    const line = lines[i];
    if (!line) continue;
    const timing = line[0]
      .trim()
      .match(
        /^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})(?:\s+.*)?$/,
      );
    if (!timing) {
      if (line[0].includes("-->"))
        diagnostics.push(`Malformed timing at UTF-16 ${line.index}.`);
      continue;
    }
    if (
      [timing[1]!, timing[2]!].some((t) => {
        const p = t.replace(",", ".").split(":").map(Number);
        return p[p.length - 1]! >= 60 || p[p.length - 2]! >= 60;
      })
    ) {
      diagnostics.push(`Invalid timestamp at UTF-16 ${line.index}.`);
      continue;
    }
    const startMs = timestamp(timing[1]!);
    const endMs = timestamp(timing[2]!);
    let stop = i + 1;
    while (
      stop < lines.length &&
      lines[stop]?.[0].trim() &&
      !lines[stop]?.[0].includes("-->")
    )
      stop++;
    let payloadStop = stop;
    if (lines[stop]?.[0].includes("-->")) {
      diagnostics.push(
        `Missing cue separator before timing at UTF-16 ${lines[stop]!.index}.`,
      );
      if (
        payloadStop > i + 1 &&
        /^\d+$/.test(lines[payloadStop - 1]?.[0].trim() ?? "")
      )
        payloadStop--;
    }
    const first = lines[i + 1];
    const last = lines[payloadStop - 1];
    if (!first || !last || payloadStop === i + 1 || endMs < startMs) {
      diagnostics.push(`Empty/reversed cue at UTF-16 ${line.index}.`);
      continue;
    }
    const previous = lines[i - 1];
    const identifier = previous?.[0].trim();
    const hasIdentifier =
      i - 1 > lastPayloadLine &&
      !!identifier &&
      !identifier.includes("-->") &&
      identifier !== "WEBVTT" &&
      !identifier.startsWith("NOTE");
    cues.push({
      ordinal: cues.length,
      originalIdentifier: hasIdentifier ? identifier : null,
      rawStart: hasIdentifier ? previous!.index : line.index,
      rawEnd: last.index + last[0].length,
      textStart: first.index,
      textEnd: last.index + last[0].replace(/[\r\n]+$/, "").length,
      startMs,
      endMs,
      timeBasis: "subtitle-file",
    });
    lastPayloadLine = payloadStop - 1;
    i = stop - 1;
  }
  if (!cues.length) diagnostics.push("No usable subtitle cues.");
  return { text, encoding, cues, diagnostics };
}
export function safeBoundary(text: string, at: number): number {
  return at > 0 && at < text.length && /[\uDC00-\uDFFF]/u.test(text[at] ?? "")
    ? at - 1
    : at;
}
export function sourceMetadata(source: Source, extraction: Extraction) {
  const subtitle = [".srt", ".str", ".vtt"].some((extension) =>
    source.path.toLowerCase().endsWith(extension),
  );
  const role = /introduction_and_comments/.test(source.quality)
    ? "introduction-and-comments"
    : /mixed_episode_page/.test(source.quality)
      ? "mixed-summary-navigation"
      : subtitle
        ? "transcript"
        : source.type;
  return {
    role,
    eligibility: "indexed",
    encoding: extraction.encoding,
    rawHash: hash(Buffer.from(extraction.text, "utf8")),
    extractionRevision: "original-cues-v1",
    diagnostics: extraction.diagnostics,
  };
}
