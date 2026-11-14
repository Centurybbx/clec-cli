import { rank } from "./retrieval.js";
import { safeBoundary, type SubtitleCue } from "./source-extraction.js";
import { DatabaseSync } from "node:sqlite";
import {
  ClecError,
  hash,
  parseSource,
  type Source,
  type Section,
  type Counts,
  type Manifest,
  type Reference,
} from "./contracts.js";
import { normalizeForSearch, queryTokens } from "./lexical.js";

import { validateCorpus } from "./corpus-format.js";
export { SCHEMA } from "./corpus-format.js";
export interface Paging {
  limit: number;
  offset: number;
}
export interface SearchOptions extends Paging {
  match: "any" | "all";
  perSource: number;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
}
export interface Page {
  offset: number;
  limit: number;
  nextOffset: number | null;
}
const page = (options: Paging, more: boolean): Page => ({
  offset: options.offset,
  limit: options.limit,
  nextOffset: more ? options.offset + options.limit : null,
});
export interface Preview {
  preview: string;
  previewKind: "match" | "leading";
  previewStart: number;
  previewEnd: number;
}
function preview(text: string, terms: string[]): Preview {
  let at = -1;
  for (const term of terms) {
    if (!term) continue;
    const found = text.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  let start = at < 0 ? 0 : Math.max(0, at - 100);
  let end = Math.min(text.length, start + 320);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) end++;
  return {
    preview: text.slice(start, end),
    previewKind: at < 0 ? "leading" : "match",
    previewStart: start,
    previewEnd: end,
  };
}
export interface Context {
  ref: string;
  section: Section;
  offsetUnit: "utf16";
  text: string;
  cues?: SubtitleCue[];
}
export interface Evidence extends Context {
  release: string;
  sourceRef: string;
  source: Source;
  context: Context[];
  previous: string | null;
  next: string | null;
  warnings: string[];
  metadata?: unknown;
  cues?: SubtitleCue[];
}
export interface ReadResult {
  release: string;
  items: Evidence[];
}
export interface SourceInfo extends Source {
  sourceRef: string;
  sectionCount: number;
  warnings: string[];
}
export interface SourcePage {
  release: string;
  query: string;
  terms: string[];
  items: SourceInfo[];
  page: Page;
}
export interface SourceSections {
  release: string;
  ref: string;
  source: SourceInfo;
  sections: (Section & Preview & { ref: string })[];
  page: Page;
}
export interface SearchHit extends Preview {
  ref: string;
  sourceRef: string;
  source: Source;
  section: Section;
  score: number;
  warnings: string[];
}
export interface SearchPage {
  release: string;
  query: string;
  match: "any" | "all";
  terms: string[];
  filters: {
    source: string | null;
    dateFrom: string | null;
    dateTo: string | null;
    perSource: number;
  };
  hits: SearchHit[];
  page: Page;
}
export class Corpus {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly release: string,
  ) {
    this.db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
    const revision = this.revision();
    if (revision !== 1 && revision !== 3) {
      this.db.close();
      throw new ClecError(
        "INVALID_PACKAGE",
        "Unsupported corpus format. Supported formats: 1 and 3; trial format 2 must be rebuilt with the BM25 publisher. Run clec sync --manifest PATH with a supported release.",
      );
    }
  }
  async close(): Promise<void> {
    this.db.close();
  }
  revision(): number {
    return Number(
      this.db
        .prepare("SELECT value FROM metadata WHERE key='formatRevision'")
        .get()?.value,
    );
  }
  counts(): Counts {
    const count = (table: string): number =>
      Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n);
    return {
      sources: count("sources"),
      sections: count("sections"),
      inventory: count("inventory"),
    };
  }
  sourceRecord(id: string): Source {
    const row = this.db
      .prepare("SELECT record FROM sources WHERE id=?")
      .get(id);
    if (!row) throw new ClecError("EVIDENCE_NOT_FOUND", "Source not found.");
    return this.sourceRecordFromJson(String(row.record));
  }
  section(row: Record<string, unknown>, source: Source): Section {
    const boundary = row.boundary;
    if (
      boundary !== "whole" &&
      boundary !== "heading" &&
      boundary !== "contiguous"
    )
      throw new ClecError("INVALID_PACKAGE", "Invalid section boundary.");
    return {
      id: String(row.id),
      sourceId: source.id,
      sourceVersion: source.version,
      order: Number(row.ordinal),
      start: Number(row.start),
      end: Number(row.end),
      boundary,
    };
  }
  warnings(source: Source): string[] {
    return [
      ...(source.date
        ? []
        : ["Source date is unknown; date filters exclude this source."]),
      ...(source.dateBasis ? [`Date basis: ${source.dateBasis}.`] : []),
      `Stored quality: ${source.quality}.`,
    ];
  }
  original(source: Source): string {
    const original = String(
      this.db.prepare("SELECT original FROM sources WHERE id=?").get(source.id)
        ?.original,
    );
    if (hash(Buffer.from(original, "utf8")) !== source.contentHash)
      throw new ClecError(
        "INTEGRITY_MISMATCH",
        "Local original no longer matches its source hash; run sync to repair.",
      );
    return original;
  }
  read(id: string, context = 1): Evidence {
    const row = this.db.prepare("SELECT * FROM sections WHERE id=?").get(id);
    if (!row) throw new ClecError("EVIDENCE_NOT_FOUND", "Section not found.");
    const source = this.sourceRecord(String(row.source_id));
    const section = this.section(row, source);
    const original = this.original(source);
    const adjacent = (order: number): string | null => {
      const next = this.db
        .prepare("SELECT id FROM sections WHERE source_id=? AND ordinal=?")
        .get(source.id, order);
      return next ? `${this.release}:${String(next.id)}` : null;
    };
    const neighbors = this.db
      .prepare(
        "SELECT * FROM sections WHERE source_id=? AND ordinal BETWEEN ? AND ? AND ordinal!=? ORDER BY ordinal",
      )
      .all(
        source.id,
        section.order - context,
        section.order + context,
        section.order,
      );
    return {
      release: this.release,
      ref: `${this.release}:${id}`,
      sourceRef: `${this.release}:${source.id}`,
      source,
      section,
      offsetUnit: "utf16",
      text: original.slice(section.start, section.end),
      context: neighbors.map((row) => {
        const s = this.section(row, source);
        return {
          ref: `${this.release}:${s.id}`,
          section: s,
          offsetUnit: "utf16",
          text: original.slice(s.start, s.end),
          cues: this.cues(source.id, s.start, s.end),
        };
      }),
      previous: adjacent(section.order - 1),
      next: adjacent(section.order + 1),
      warnings: this.warnings(source),
      ...(this.revision() === 3
        ? {
            metadata: this.metadata(source.id),
            cues: this.cues(source.id, section.start, section.end),
          }
        : {}),
    };
  }
  readMany(refs: Reference[], context: number): ReadResult {
    const items = refs.map((ref, inputIndex) => {
      try {
        return this.read(ref.id, context);
      } catch (error) {
        if (error instanceof ClecError)
          throw new ClecError(error.code, error.message, { inputIndex });
        throw error;
      }
    });
    return { release: this.release, items };
  }
  sourceInfo(source: Source): SourceInfo {
    return {
      ...source,
      sourceRef: `${this.release}:${source.id}`,
      sectionCount: Number(
        this.db
          .prepare("SELECT count(*) n FROM sections WHERE source_id=?")
          .get(source.id)?.n,
      ),
      warnings: this.warnings(source),
    };
  }
  sources(query: string, options: Paging): SourcePage {
    if (query.length > 512 || query.includes("\0"))
      throw new ClecError(
        "INVALID_QUERY",
        "Discovery query must be at most 512 UTF-16 units without NUL.",
      );
    const terms = normalizeForSearch(query)
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    const found = this.db
      .prepare("SELECT record FROM sources")
      .all()
      .map((row) => this.sourceRecordFromJson(String(row.record)))
      .map((source) => ({
        source,
        title: normalizeForSearch(source.title),
        path: normalizeForSearch(source.path),
      }))
      .filter((item) =>
        terms.every((term) => `${item.title}\n${item.path}`.includes(term)),
      );
    const compare = (a: string, b: string): number =>
      a < b ? -1 : a > b ? 1 : 0;
    found.sort(
      (a, b) =>
        compare(a.title, b.title) ||
        compare(a.path, b.path) ||
        compare(a.source.id, b.source.id),
    );
    return {
      release: this.release,
      query,
      terms,
      items: found
        .slice(options.offset, options.offset + options.limit)
        .map((item) => this.sourceInfo(item.source)),
      page: page(options, found.length > options.offset + options.limit),
    };
  }
  sourceRecordFromJson(record: string): Source {
    try {
      return parseSource(JSON.parse(record));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new ClecError(
          "INVALID_PACKAGE",
          "Source metadata is not valid JSON.",
        );
      throw error;
    }
  }
  source(id: string, offset: number, limit: number): SourceSections {
    const source = this.sourceRecord(id);
    const original = this.original(source);
    const rows = this.db
      .prepare(
        "SELECT * FROM sections WHERE source_id=? ORDER BY ordinal LIMIT ? OFFSET ?",
      )
      .all(id, limit + 1, offset);
    return {
      release: this.release,
      ref: `${this.release}:${id}`,
      source: this.sourceInfo(source),
      sections: rows.slice(0, limit).map((row) => {
        const section = this.section(row, source);
        return {
          ref: `${this.release}:${section.id}`,
          ...section,
          ...preview(original.slice(section.start, section.end), []),
        };
      }),
      page: page({ offset, limit }, rows.length > limit),
    };
  }
  metadata(id: string): unknown {
    const row = this.db
      .prepare("SELECT record FROM source_metadata WHERE source_id=?")
      .get(id);
    return row ? JSON.parse(String(row.record)) : null;
  }
  cues(id: string, start: number, end: number): SubtitleCue[] {
    if (this.revision() !== 3) return [];
    return this.db
      .prepare(
        "SELECT record FROM cues WHERE source_id=? AND json_extract(record,'$.textEnd')>? AND json_extract(record,'$.textStart')<? ORDER BY ordinal",
      )
      .all(id, start, end)
      .map((row) => JSON.parse(String(row.record)));
  }
  coverage() {
    return {
      release: this.release,
      formatRevision: this.revision(),
      capabilities: ["bm25", "find", "read-range"],
      counts: this.counts(),
      inventory: this.db
        .prepare(
          "SELECT status,reason,count(*) count FROM inventory GROUP BY status,reason ORDER BY status,reason",
        )
        .all(),
      extractionDiagnostics:
        this.revision() === 3
          ? {
              sources: Number(
                this.db
                  .prepare(
                    "SELECT count(*) n FROM source_metadata WHERE json_array_length(json_extract(record,'$.diagnostics'))>0",
                  )
                  .get()?.n,
              ),
              entries: Number(
                this.db
                  .prepare(
                    "SELECT coalesce(sum(json_array_length(json_extract(record,'$.diagnostics'))),0) n FROM source_metadata",
                  )
                  .get()?.n,
              ),
              warning:
                "Partial subtitle extraction retains original text and lexical search. Inspect read metadata diagnostics before relying on cue payloads.",
            }
          : null,
      qualities: this.db
        .prepare(
          "SELECT json_extract(record,'$.quality') quality,count(*) count FROM sources GROUP BY quality ORDER BY quality",
        )
        .all(),
      unknownDates: Number(
        this.db
          .prepare(
            "SELECT count(*) count FROM sources WHERE json_extract(record,'$.date') IS NULL",
          )
          .get()?.count,
      ),
      warning:
        "Coverage describes admitted inputs. Exhausting matching sections never proves that relevant evidence is absent. Editions and duplicate sources are not independent evidence.",
    };
  }
  readRange(id: string, start: number, end: number) {
    const source = this.sourceRecord(id);
    const text = this.original(source);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > text.length ||
      end - start > 20000 ||
      safeBoundary(text, start) !== start ||
      safeBoundary(text, end) !== end
    )
      throw new ClecError(
        "INVALID_ARGUMENT",
        "Range must be an exact UTF-16 interval of 1..20000 units, within the source and without splitting surrogate pairs.",
      );
    return {
      release: this.release,
      sourceRef: `${this.release}:${id}`,
      source,
      start,
      end,
      offsetUnit: "utf16",
      text: text.slice(start, end),
      cues: this.cues(id, start, end),
      metadata: this.revision() === 3 ? this.metadata(id) : null,
    };
  }
  find(query: string, options: Paging & { source?: string }) {
    if (!query || query.length > 512 || query.includes("\0"))
      throw new ClecError(
        "INVALID_QUERY",
        "Literal find needs 1..512 UTF-16 units without NUL.",
      );
    const hits: {
      sourceRef: string;
      source: Source;
      start: number;
      end: number;
      sectionRefs: string[];
    }[] = [];
    let count = 0;
    for (const row of this.db
      .prepare(
        "SELECT id,record,original FROM sources WHERE (? IS NULL OR id=?) ORDER BY id",
      )
      .iterate(options.source ?? null, options.source ?? null)) {
      const text = String(row.original);
      const source = this.sourceRecordFromJson(String(row.record));
      for (
        let at = text.indexOf(query);
        at >= 0;
        at = text.indexOf(query, at + 1)
      ) {
        if (count++ < options.offset) continue;
        hits.push({
          sourceRef: `${this.release}:${source.id}`,
          source,
          start: at,
          end: at + query.length,
          sectionRefs: this.db
            .prepare(
              "SELECT id FROM sections WHERE source_id=? AND end>? AND start<? ORDER BY ordinal",
            )
            .all(source.id, at, at + query.length)
            .map((s) => `${this.release}:${String(s.id)}`),
        });
        if (hits.length > options.limit)
          return {
            release: this.release,
            query,
            normalization: "none",
            offsetUnit: "utf16",
            hits: hits.slice(0, options.limit),
            page: page(options, true),
          };
      }
    }
    return {
      release: this.release,
      query,
      normalization: "none",
      offsetUnit: "utf16",
      hits,
      page: page(options, false),
    };
  }
  async search(query: string, options: SearchOptions): Promise<SearchPage> {
    const tokens = queryTokens(query);
    const terms = tokens.map((t) =>
      Buffer.from(t.slice(1), "hex").toString("utf8"),
    );
    const ranked = rank(this.db, query, options);
    return {
      release: this.release,
      query,
      match: options.match,
      terms,
      filters: {
        source: options.source ?? null,
        dateFrom: options.dateFrom ?? null,
        dateTo: options.dateTo ?? null,
        perSource: options.perSource,
      },
      hits: ranked.candidates.map((candidate) => {
        const row = this.db
          .prepare("SELECT * FROM sections WHERE id=?")
          .get(candidate.id)!;
        const source = this.sourceRecord(String(row.source_id));
        const section = this.section(row, source);
        const original = this.original(source);
        return {
          ref: `${this.release}:${section.id}`,
          sourceRef: `${this.release}:${source.id}`,
          source,
          section,
          score: candidate.score,
          metadata: this.revision() === 3 ? this.metadata(source.id) : null,
          cues: this.cues(source.id, section.start, section.end),
          ...preview(original.slice(section.start, section.end), [query, ...terms]),
          warnings: this.warnings(source),
        };
      }),
      page: page(options, ranked.more),
    };
  }
  validate(manifest: Manifest): void {
    try {
      validateCorpus(this.db, manifest);
    } catch (error) {
      if (error instanceof ClecError) throw error;
      throw new ClecError(
        "INVALID_PACKAGE",
        `Corpus validation failed. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
