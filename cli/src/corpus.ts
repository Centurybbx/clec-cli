import { DatabaseSync } from 'node:sqlite';
import { ClecError, hash, parseSource, SEGMENTATION_REVISION, type Source, type Section, type Counts, type Manifest } from './contracts.js';
import { queryTokens } from './lexical.js';

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
export class Corpus {
  readonly db: DatabaseSync;
  constructor(path: string, readonly release: string) {
    this.db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  }
  close(): void { this.db.close(); }
  counts(): Counts {
    const count = (table: string): number => Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n);
    return { sources: count('sources'), sections: count('sections'), inventory: count('inventory') };
  }
  sourceRecord(id: string): Source {
    const row = this.db.prepare('SELECT record FROM sources WHERE id=?').get(id);
    if (!row) throw new ClecError('EVIDENCE_NOT_FOUND', 'Source not found.');
    return parseSource(JSON.parse(String(row.record)));
  }
  section(row: Record<string, unknown>, source: Source): Section {
    const boundary = row.boundary;
    if (boundary !== 'whole' && boundary !== 'heading' && boundary !== 'contiguous') throw new ClecError('INVALID_PACKAGE', 'Invalid section boundary.');
    return { id: String(row.id), sourceId: source.id, sourceVersion: source.version, order: Number(row.ordinal), start: Number(row.start), end: Number(row.end), boundary };
  }
  read(id: string): object {
    const row = this.db.prepare('SELECT * FROM sections WHERE id=?').get(id);
    if (!row) throw new ClecError('EVIDENCE_NOT_FOUND', 'Section not found.');
    const source = this.sourceRecord(String(row.source_id)); const section = this.section(row, source);
    const original = String(this.db.prepare('SELECT original FROM sources WHERE id=?').get(source.id)?.original);
    if (hash(Buffer.from(original, 'utf8')) !== source.contentHash) throw new ClecError('INTEGRITY_MISMATCH', 'Local original content no longer matches its source hash; run sync to repair.');
    const adjacent = (order: number): string | null => {
      const next = this.db.prepare('SELECT id FROM sections WHERE source_id=? AND ordinal=?').get(source.id, order);
      return next ? `${this.release}:${String(next.id)}` : null;
    };
    return { release: this.release, ref: `${this.release}:${id}`, sourceRef: `${this.release}:${source.id}`, source, section, offsetUnit: 'utf16', text: original.slice(section.start, section.end), previous: adjacent(section.order - 1), next: adjacent(section.order + 1) };
  }
  source(id: string, offset: number, limit: number): object {
    const source = this.sourceRecord(id);
    const rows = this.db.prepare('SELECT * FROM sections WHERE source_id=? ORDER BY ordinal LIMIT ? OFFSET ?').all(id, limit + 1, offset);
    return { release: this.release, ref: `${this.release}:${id}`, source, sections: rows.slice(0, limit).map(row => ({ ref: `${this.release}:${String(row.id)}`, ...this.section(row, source) })), nextOffset: rows.length > limit ? offset + limit : null };
  }
  search(query: string, options: { limit: number; match?: 'any' | 'all'; source?: string; dateFrom?: string; dateTo?: string }): object {
    const terms = queryTokens(query);
    const match = options.match ?? 'any';
    const rows = this.db.prepare(`SELECT s.*,bm25(search,4.0,1.0) score FROM search JOIN sections s ON s.rowid=search.rowid JOIN sources o ON o.id=s.source_id WHERE search MATCH ? AND (? IS NULL OR s.source_id=?) AND (? IS NULL OR json_extract(o.record,'$.date')>=?) AND (? IS NULL OR json_extract(o.record,'$.date')<=?) ORDER BY score,s.id LIMIT ?`).all(terms.map(t => `"${t}"`).join(match === 'all' ? ' AND ' : ' OR '), options.source ?? null, options.source ?? null, options.dateFrom ?? null, options.dateFrom ?? null, options.dateTo ?? null, options.dateTo ?? null, options.limit);
    return { release: this.release, match, terms: terms.map(term => Buffer.from(term.slice(1), 'hex').toString('utf8')), hits: rows.map(row => {
      const source = this.sourceRecord(String(row.source_id)); const section = this.section(row, source);
      const original = String(this.db.prepare('SELECT original FROM sources WHERE id=?').get(source.id)?.original);
      return { ref: `${this.release}:${section.id}`, sourceRef: `${this.release}:${source.id}`, source, section, score: Number(row.score), preview: original.slice(section.start, Math.min(section.end, section.start + 320)) };
    }) };
  }
  validate(manifest: Manifest): void {
    const schema = this.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec(SCHEMA);
      const expectedSchema = expected.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if (JSON.stringify(schema) !== JSON.stringify(expectedSchema)) throw new ClecError('INVALID_PACKAGE', 'Unexpected database schema.');
    } finally { expected.close(); }
    if (this.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new ClecError('INVALID_PACKAGE', 'SQLite integrity failed.');
    const metadata = this.db.prepare('SELECT key,value FROM metadata ORDER BY key').all();
    if (JSON.stringify(metadata) !== JSON.stringify([{ key: 'formatRevision', value: '1' }, { key: 'segmentationRevision', value: SEGMENTATION_REVISION }])) throw new ClecError('INVALID_PACKAGE', 'Unsupported corpus metadata.');
    if (JSON.stringify(this.counts()) !== JSON.stringify(manifest.counts)) throw new ClecError('INVALID_PACKAGE', 'Release counts mismatch.');
    if (this.db.prepare('SELECT 1 FROM sources WHERE length(CAST(original AS BLOB))>100000000 OR length(CAST(record AS BLOB))>65536 LIMIT 1').get()) throw new ClecError('INVALID_PACKAGE', 'Source exceeds admitted size bounds.');
    if (this.db.prepare('SELECT 1 FROM inventory WHERE length(path)>4096 OR length(status)>64 OR length(reason)>4096 LIMIT 1').get()) throw new ClecError('INVALID_PACKAGE', 'Inventory exceeds metadata bounds.');
    if (this.db.prepare("SELECT 1 FROM sources s LEFT JOIN inventory i ON i.path=json_extract(s.record,'$.path') WHERE i.path IS NULL OR i.status!='indexed' OR i.content_hash IS NULL OR i.content_hash!=json_extract(s.record,'$.contentHash') LIMIT 1").get() || Number(this.db.prepare("SELECT count(*) n FROM inventory WHERE status='indexed'").get()?.n) !== manifest.counts.sources) throw new ClecError('INVALID_PACKAGE', 'Inventory admission mismatch.');
    let seenSections = 0;
    for (const row of this.db.prepare('SELECT * FROM sources ORDER BY id').iterate()) {
      const source = parseSource(JSON.parse(String(row.record))); const original = String(row.original);
      if (row.id !== source.id || row.version !== source.version || hash(Buffer.from(original, 'utf8')) !== source.contentHash || !original.trim() || original.includes('\0')) throw new ClecError('INVALID_PACKAGE', 'Source hash or identity mismatch.');
      let end = 0; let order = 0;
      for (const raw of this.db.prepare('SELECT rowid,* FROM sections WHERE source_id=? ORDER BY ordinal').iterate(source.id)) {
        const s = this.section(raw, source);
        if (s.order !== order++ || s.start !== end || !Number.isSafeInteger(s.end) || s.end <= s.start || s.end - s.start > 5000 || s.end > original.length || s.id !== hash(`${source.version}:${s.start}:${s.end}:${SEGMENTATION_REVISION}`)) throw new ClecError('INVALID_PACKAGE', 'Invalid exact section spans.');
        end = s.end; seenSections++;
        const indexed = this.db.prepare('SELECT rowid FROM search WHERE rowid=?').get(Number(raw.rowid));
        if (!indexed) throw new ClecError('INVALID_PACKAGE', 'Missing FTS row.');
      }
      if (!order || end !== original.length) throw new ClecError('INVALID_PACKAGE', 'Incomplete original coverage.');
    }
    if (seenSections !== manifest.counts.sections || Number(this.db.prepare('SELECT count(*) n FROM search').get()?.n) !== seenSections) throw new ClecError('INVALID_PACKAGE', 'Orphan section or FTS rows.');
  }
}
