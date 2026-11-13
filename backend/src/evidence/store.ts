import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Passage, Section, Source } from '../domain/contracts.js';
import { hash } from '../domain/hash.js';
import { ClecError } from '../domain/errors.js';

export interface SourceBundle { source: Source; original: string; sections: Section[]; passages: Passage[] }

/** Owns exact originals only. Search-normalized text lives exclusively in Markdown. */
export class EvidenceStore {
  private readonly db: DatabaseSync;
  readonly generationId: string | undefined;
  private readonly statements = new Map<string, StatementSync>();
  constructor(path: string, private readonly readonly = true) {
    const directoryId = basename(dirname(resolve(path)));
    this.generationId = /^[a-f0-9]{64}$/.test(directoryId) ? directoryId : undefined;
    this.db = new DatabaseSync(path, { readOnly: readonly });
    this.db.exec('PRAGMA foreign_keys=ON');
    if (!readonly) this.db.exec(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE sources(id TEXT PRIMARY KEY, version TEXT NOT NULL, record TEXT NOT NULL, original TEXT NOT NULL);
      CREATE TABLE sections(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), ordinal INTEGER NOT NULL, record TEXT NOT NULL);
      CREATE INDEX sections_source ON sections(source_id, ordinal);
      CREATE TABLE passages(id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id), record TEXT NOT NULL);
    `);
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  add(source: Source, original: string, sections: Section[]): Passage[] {
    const passages = sections.map(section => ({ id: section.id, sectionId: section.id, sourceId: source.id, sourceVersion: source.version, start: section.start, end: section.end }));
    this.importSourceBundle({ source, original, sections, passages });
    return passages;
  }
  /** One bounded-by-intake-size source transaction; failure rolls back every row. */
  importSourceBundle(bundle: SourceBundle): void {
    if (this.readonly) throw new ClecError('INVALID_INDEX', 'Cannot write a published evidence store.');
    const { source, original, sections, passages } = bundle;
    if (source.id !== hash(source.path) || !/^[a-f0-9]{64}$/.test(source.version) || source.contentHash !== hash(Buffer.from(original, 'utf8')) || !sections.length || sections.length !== passages.length) throw new ClecError('INVALID_INDEX', 'Invalid source bundle.');
    let end = 0;
    const ids = new Set<string>();
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!;
      const p = passages[i]!;
      if (s.sourceId !== source.id || s.sourceVersion !== source.version || s.order !== i ||
          !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start !== end || s.end <= s.start || s.end > original.length ||
          !['whole', 'heading', 'contiguous'].includes(s.boundary) || !/^[a-f0-9]{64}$/.test(s.id) || ids.has(s.id) || p.id !== s.id || p.sectionId !== s.id || p.sourceId !== source.id || p.sourceVersion !== source.version || p.start !== s.start || p.end !== s.end) {
        throw new ClecError('INVALID_INDEX', 'Source bundle spans or provenance are inconsistent.');
      }
      ids.add(s.id); end = s.end;
    }
    if (end !== original.length) throw new ClecError('INVALID_INDEX', 'Source bundle must cover the complete original.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statement('INSERT INTO sources VALUES(?,?,?,?)').run(source.id, source.version, JSON.stringify(source), original);
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]!;
        const passage = passages[i]!;
        this.statement('INSERT INTO sections VALUES(?,?,?,?)').run(section.id, source.id, section.order, JSON.stringify(section));
        this.statement('INSERT INTO passages VALUES(?,?,?)').run(passage.id, section.id, JSON.stringify(passage));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  exportSourceBundle(sourceId: string): SourceBundle {
    const sections = this.sections(sourceId);
    return { source: this.source(sourceId), original: this.original(sourceId), sections, passages: sections.map(s => this.passage(s.id)) };
  }
  sources(): Source[] { return this.statement('SELECT record FROM sources ORDER BY id').all().map(r => JSON.parse(String(r.record)) as Source); }
  source(id: string): Source { return this.record<Source>('sources', id); }
  section(id: string): Section { return this.record<Section>('sections', id); }
  passage(id: string): Passage { return this.record<Passage>('passages', id); }
  private record<T>(table: 'sources' | 'sections' | 'passages', id: string): T {
    const row = this.statement(`SELECT record FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new ClecError('EVIDENCE_NOT_FOUND', 'Evidence locator is not in the pinned generation.');
    return JSON.parse(String(row.record)) as T;
  }
  original(sourceId: string): string {
    const row = this.statement('SELECT original FROM sources WHERE id=?').get(sourceId);
    if (!row) throw new ClecError('EVIDENCE_NOT_FOUND', 'Source is not in the pinned generation.');
    return String(row.original);
  }
  sections(sourceId: string): Section[] {
    return this.statement('SELECT record FROM sections WHERE source_id=? ORDER BY ordinal').all(sourceId).map(r => JSON.parse(String(r.record)) as Section);
  }
  counts(): { sources: number; sections: number } {
    return { sources: Number(this.statement('SELECT count(*) n FROM sources').get()!.n), sections: Number(this.statement('SELECT count(*) n FROM sections').get()!.n) };
  }
  close(): void { this.statements.clear(); this.db.close(); }
}
