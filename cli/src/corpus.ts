import { DatabaseSync } from "node:sqlite";
import {
  ClecError,
  hash,
  parseSource,
  SEGMENTATION_REVISION,
  type Source,
  type Section,
  type Counts,
  type Manifest,
  type Reference,
} from "./contracts.js";
import { normalizeForSearch, queryTokens } from "./lexical.js";

export const SCHEMA = `
PRAGMA journal_mode=DELETE;
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO metadata VALUES('formatRevision','1'),('segmentationRevision','${SEGMENTATION_REVISION}');
CREATE TABLE sources(id TEXT PRIMARY KEY,version TEXT NOT NULL,record TEXT NOT NULL,original TEXT NOT NULL);
CREATE TABLE sections(id TEXT UNIQUE NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),ordinal INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,boundary TEXT NOT NULL);
CREATE UNIQUE INDEX sections_source ON sections(source_id,ordinal);
CREATE TABLE inventory(path TEXT PRIMARY KEY,status TEXT NOT NULL,reason TEXT NOT NULL,content_hash TEXT);
CREATE VIRTUAL TABLE search USING fts5(title,tokens,content='',tokenize='ascii');
`;
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
}
export interface Evidence extends Context {
  release: string;
  sourceRef: string;
  source: Source;
  context: Context[];
  previous: string | null;
  next: string | null;
  warnings: string[];
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
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly release: string,
  ) {
    this.db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
  }
  close(): void {
    this.db.close();
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
        };
      }),
      previous: adjacent(section.order - 1),
      next: adjacent(section.order + 1),
      warnings: this.warnings(source),
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
  search(query: string, options: SearchOptions): SearchPage {
    const tokens = queryTokens(query);
    const terms = tokens.map((term) =>
      Buffer.from(term.slice(1), "hex").toString("utf8"),
    );
    // MATERIALIZED computes bm25 in the FTS relation before the window function.
    const rows = this.db
      .prepare(
        `WITH scored AS MATERIALIZED (SELECT s.*,bm25(search,4.0,1.0) score FROM search JOIN sections s ON s.rowid=search.rowid JOIN sources o ON o.id=s.source_id WHERE search MATCH ? AND (? IS NULL OR s.source_id=?) AND (? IS NULL OR json_extract(o.record,'$.date')>=?) AND (? IS NULL OR json_extract(o.record,'$.date')<=?)), ranked AS (SELECT *,row_number() OVER (PARTITION BY source_id ORDER BY score,id) source_rank FROM scored) SELECT * FROM ranked WHERE source_rank<=? ORDER BY score,id LIMIT ? OFFSET ?`,
      )
      .all(
        tokens
          .map((t) => `"${t}"`)
          .join(options.match === "all" ? " AND " : " OR "),
        options.source ?? null,
        options.source ?? null,
        options.dateFrom ?? null,
        options.dateFrom ?? null,
        options.dateTo ?? null,
        options.dateTo ?? null,
        options.perSource,
        options.limit + 1,
        options.offset,
      );
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
      hits: rows.slice(0, options.limit).map((row) => {
        const source = this.sourceRecord(String(row.source_id));
        const section = this.section(row, source);
        const original = this.original(source);
        return {
          ref: `${this.release}:${section.id}`,
          sourceRef: `${this.release}:${source.id}`,
          source,
          section,
          score: Number(row.score),
          ...preview(original.slice(section.start, section.end), [
            query,
            ...terms,
          ]),
          warnings: this.warnings(source),
        };
      }),
      page: page(options, rows.length > options.limit),
    };
  }
  validate(manifest: Manifest): void {
    const schema = this.db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const expected = new DatabaseSync(":memory:");
    try {
      expected.exec(SCHEMA);
      const expectedSchema = expected
        .prepare(
          "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      if (JSON.stringify(schema) !== JSON.stringify(expectedSchema))
        throw new ClecError("INVALID_PACKAGE", "Unexpected database schema.");
    } finally {
      expected.close();
    }
    if (
      this.db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new ClecError("INVALID_PACKAGE", "SQLite integrity failed.");
    const metadata = this.db
      .prepare("SELECT key,value FROM metadata ORDER BY key")
      .all();
    if (
      JSON.stringify(metadata) !==
      JSON.stringify([
        { key: "formatRevision", value: "1" },
        { key: "segmentationRevision", value: SEGMENTATION_REVISION },
      ])
    )
      throw new ClecError("INVALID_PACKAGE", "Unsupported corpus metadata.");
    if (JSON.stringify(this.counts()) !== JSON.stringify(manifest.counts))
      throw new ClecError("INVALID_PACKAGE", "Release counts mismatch.");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sources WHERE length(CAST(original AS BLOB))>100000000 OR length(CAST(record AS BLOB))>65536 LIMIT 1",
        )
        .get()
    )
      throw new ClecError(
        "INVALID_PACKAGE",
        "Source exceeds admitted size bounds.",
      );
    if (
      this.db
        .prepare(
          "SELECT 1 FROM inventory WHERE length(path)>4096 OR length(status)>64 OR length(reason)>4096 LIMIT 1",
        )
        .get()
    )
      throw new ClecError(
        "INVALID_PACKAGE",
        "Inventory exceeds metadata bounds.",
      );
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sources s LEFT JOIN inventory i ON i.path=json_extract(s.record,'$.path') WHERE i.path IS NULL OR i.status!='indexed' OR i.content_hash IS NULL OR i.content_hash!=json_extract(s.record,'$.contentHash') LIMIT 1",
        )
        .get() ||
      Number(
        this.db
          .prepare("SELECT count(*) n FROM inventory WHERE status='indexed'")
          .get()?.n,
      ) !== manifest.counts.sources
    )
      throw new ClecError("INVALID_PACKAGE", "Inventory admission mismatch.");
    let seenSections = 0;
    for (const row of this.db
      .prepare("SELECT * FROM sources ORDER BY id")
      .iterate()) {
      const source = parseSource(JSON.parse(String(row.record)));
      const original = String(row.original);
      if (
        row.id !== source.id ||
        row.version !== source.version ||
        hash(Buffer.from(original, "utf8")) !== source.contentHash ||
        !original.trim() ||
        original.includes("\0")
      )
        throw new ClecError(
          "INVALID_PACKAGE",
          "Source hash or identity mismatch.",
        );
      let end = 0;
      let order = 0;
      for (const raw of this.db
        .prepare(
          "SELECT rowid,* FROM sections WHERE source_id=? ORDER BY ordinal",
        )
        .iterate(source.id)) {
        const s = this.section(raw, source);
        if (
          s.order !== order++ ||
          s.start !== end ||
          !Number.isSafeInteger(s.end) ||
          s.end <= s.start ||
          s.end - s.start > 5000 ||
          s.end > original.length ||
          s.id !==
            hash(
              `${source.version}:${s.start}:${s.end}:${SEGMENTATION_REVISION}`,
            )
        )
          throw new ClecError(
            "INVALID_PACKAGE",
            "Invalid exact section spans.",
          );
        end = s.end;
        seenSections++;
        const indexed = this.db
          .prepare("SELECT rowid FROM search WHERE rowid=?")
          .get(Number(raw.rowid));
        if (!indexed)
          throw new ClecError("INVALID_PACKAGE", "Missing FTS row.");
      }
      if (!order || end !== original.length)
        throw new ClecError("INVALID_PACKAGE", "Incomplete original coverage.");
    }
    if (
      seenSections !== manifest.counts.sections ||
      Number(this.db.prepare("SELECT count(*) n FROM search").get()?.n) !==
        seenSections
    )
      throw new ClecError("INVALID_PACKAGE", "Orphan section or FTS rows.");
  }
}
