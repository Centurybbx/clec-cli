import { DatabaseSync } from "node:sqlite";
import { extname } from "node:path";
import { ClecError, hash, parseSource, type Manifest } from "./contracts.js";
import { extract, sourceMetadata } from "./source-extraction.js";
import { SEGMENTATION_REVISION } from "./contracts.js";
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

export const CURRENT_SCHEMA =
  SCHEMA.replace("('formatRevision','1')", "('formatRevision','3')") + `
CREATE TABLE source_metadata(source_id TEXT PRIMARY KEY,record TEXT NOT NULL);
CREATE TABLE cues(source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(source_id,ordinal));
`;

export function validateCorpus(db: DatabaseSync, manifest: Manifest): void {
  const schema = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(manifest.formatRevision === 3 ? CURRENT_SCHEMA : SCHEMA);
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
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
    throw new ClecError("INVALID_PACKAGE", "SQLite integrity failed.");
  const metadata = db
    .prepare("SELECT key,value FROM metadata ORDER BY key")
    .all();
  if (
    JSON.stringify(metadata) !==
    JSON.stringify([
      { key: "formatRevision", value: String(manifest.formatRevision) },
      { key: "segmentationRevision", value: SEGMENTATION_REVISION },
    ])
  )
    throw new ClecError("INVALID_PACKAGE", "Unsupported corpus metadata.");
  if (
    JSON.stringify({
      sources: Number(db.prepare("SELECT count(*) n FROM sources").get()?.n),
      sections: Number(db.prepare("SELECT count(*) n FROM sections").get()?.n),
      inventory: Number(
        db.prepare("SELECT count(*) n FROM inventory").get()?.n,
      ),
    }) !== JSON.stringify(manifest.counts)
  )
    throw new ClecError("INVALID_PACKAGE", "Release counts mismatch.");
  if (
    db
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
    db
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
    db
      .prepare(
        "SELECT 1 FROM sources s LEFT JOIN inventory i ON i.path=json_extract(s.record,'$.path') WHERE i.path IS NULL OR i.status!='indexed' OR i.content_hash IS NULL OR i.content_hash!=json_extract(s.record,'$.contentHash') LIMIT 1",
      )
      .get() ||
    Number(
      db
        .prepare("SELECT count(*) n FROM inventory WHERE status='indexed'")
        .get()?.n,
    ) !== manifest.counts.sources
  )
    throw new ClecError("INVALID_PACKAGE", "Inventory admission mismatch.");
  let seenSections = 0;
  for (const row of db.prepare("SELECT * FROM sources ORDER BY id").iterate()) {
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
    for (const raw of db
      .prepare(
        "SELECT rowid,* FROM sections WHERE source_id=? ORDER BY ordinal",
      )
      .iterate(source.id)) {
      const s = {
        id: String(raw.id),
        order: Number(raw.ordinal),
        start: Number(raw.start),
        end: Number(raw.end),
      };
      if (!["whole", "heading", "contiguous"].includes(String(raw.boundary)))
        throw new ClecError("INVALID_PACKAGE", "Invalid section boundary.");
      if (
        s.order !== order++ ||
        s.start !== end ||
        !Number.isSafeInteger(s.end) ||
        s.end <= s.start ||
        s.end - s.start > 5000 ||
        s.end > original.length ||
        s.id !==
          hash(`${source.version}:${s.start}:${s.end}:${SEGMENTATION_REVISION}`)
      )
        throw new ClecError("INVALID_PACKAGE", "Invalid exact section spans.");
      end = s.end;
      seenSections++;
      const indexed = db
        .prepare("SELECT rowid FROM search WHERE rowid=?")
        .get(Number(raw.rowid));
      if (!indexed) throw new ClecError("INVALID_PACKAGE", "Missing FTS row.");
    }
    if (!order || end !== original.length)
      throw new ClecError("INVALID_PACKAGE", "Incomplete original coverage.");
  }
  if (manifest.formatRevision === 3) validateExtraction(db);
  if (
    seenSections !== manifest.counts.sections ||
    Number(db.prepare("SELECT count(*) n FROM search").get()?.n) !==
      seenSections
  )
    throw new ClecError("INVALID_PACKAGE", "Orphan section or FTS rows.");
}

function validateExtraction(db: DatabaseSync): void {
  let cueCount = 0;
  let metadataCount = 0;
  for (const sourceRow of db
    .prepare("SELECT * FROM sources ORDER BY rowid")
    .iterate()) {
    const source = parseSource(JSON.parse(String(sourceRow.record)));
    const original = String(sourceRow.original);
    const subtitle = [".srt", ".str", ".vtt"].includes(
      extname(source.path).toLowerCase(),
    );
    const extraction = extract(Buffer.from(original, "utf8"), subtitle);
    const expectedMetadata = sourceMetadata(source, extraction);
    const metadata = db
      .prepare("SELECT record FROM source_metadata WHERE source_id=?")
      .get(source.id);
    if (
      !metadata ||
      JSON.stringify(JSON.parse(String(metadata.record))) !==
        JSON.stringify(expectedMetadata)
    )
      throw new ClecError(
        "INVALID_PACKAGE",
        "Source extraction metadata mismatch.",
      );
    metadataCount++;
    const storedCues = db
      .prepare(
        "SELECT ordinal,record FROM cues WHERE source_id=? ORDER BY ordinal",
      )
      .all(source.id);
    if (
      storedCues.length !== extraction.cues.length ||
      storedCues.some(
        (c, i) =>
          c.ordinal !== i ||
          JSON.stringify(JSON.parse(String(c.record))) !==
            JSON.stringify(extraction.cues[i]),
      )
    )
      throw new ClecError(
        "INVALID_PACKAGE",
        "Subtitle cues differ from original extraction.",
      );
    cueCount += storedCues.length;
  }
  if (
    Number(db.prepare("SELECT count(*) n FROM cues").get()?.n) !== cueCount ||
    Number(db.prepare("SELECT count(*) n FROM source_metadata").get()?.n) !==
      metadataCount
  )
    throw new ClecError(
      "INVALID_PACKAGE",
      "Orphan cue or extraction metadata.",
    );
}
