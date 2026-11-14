import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IntakeSource } from '../domain/contracts.js';
import type { Candidate, CatalogueEntry, CatalogueIssue, CatalogueRelationship, RecordData, RecordReference } from './types.js';

export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
export const object = (value: unknown): value is RecordData => value !== null && typeof value === 'object' && !Array.isArray(value);
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const quarantined = (value: unknown): boolean => typeof value === 'string' && /quarantin|do_not_use|suspected_hallucination/i.test(value);

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A labelled title date is useful provenance, not a claim about recording/publication. */
function sourceDate(title: string, record: RecordData): { date?: string; dateBasis: string } {
  const declared = string(record.date);
  if (declared && /^\d{4}-\d{2}-\d{2}$/.test(declared) && validDate(declared)) {
    return { date: declared, dateBasis: string(record.dateBasis) ?? string(record.date_basis) ?? 'declared_manifest_date' };
  }
  const dates = new Set<string>();
  for (const match of title.matchAll(/(?<!\d)((?:19|20)\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})(?:\s*[日號])?(?!\d)/g)) {
    const date = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
    if (validDate(date)) dates.add(date);
  }
  return dates.size === 1 ? { date: [...dates][0]!, dateBasis: 'source_title' } : { dateBasis: 'unknown' };
}

/** No collection mutation, shell invocation, network request, or derived-text rewriting. */
export class CatalogueContext {
  readonly entries: CatalogueEntry[] = [];
  readonly relationships: CatalogueRelationship[] = [];
  readonly issues: CatalogueIssue[] = [];
  constructor(readonly root: string) {}

  issue(file: string, code: string, message: string, record?: number): void {
    this.issues.push({ file, code, message, ...(record === undefined ? {} : { record }) });
  }

  async safePath(path: string): Promise<string> {
    if (isAbsolute(path) || path.includes('\\')) throw new Error('Expected workspace-relative POSIX path');
    const target = resolve(this.root, path);
    const rel = relative(this.root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes workspace');
    // Check existing ancestors as well as the final file, including missing paths beneath symlinks.
    let current = this.root;
    for (const part of rel.split(sep)) {
      current = resolve(current, part);
      try {
        const actual = await realpath(current);
        const realRel = relative(this.root, actual);
        if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error('Symlink escapes workspace');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    return target;
  }

  async read(path: string): Promise<Uint8Array> {
    return readFile(await this.safePath(path));
  }

  async text(path: string): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await this.read(path));
  }

  async names(path: string): Promise<string[]> {
    try { return (await readdir(await this.safePath(path))).sort(compare); }
    catch (error) { this.issue(path, 'directory_unavailable', (error as Error).message); return []; }
  }

  async isDirectory(path: string): Promise<boolean> {
    try { return (await stat(await this.safePath(path))).isDirectory(); }
    catch (error) { this.issue(path, 'stat_failed', (error as Error).message); return false; }
  }

  async records(file: string): Promise<{ data: RecordData; reference: RecordReference }[]> {
    let text: string;
    try { text = await this.text(file); }
    catch (error) { this.issue(file, 'manifest_unavailable', (error as Error).message); return []; }
    const result: { data: RecordData; reference: RecordReference }[] = [];
    const accept = (value: unknown, record: number): void => {
      if (object(value)) result.push({ data: value, reference: { file, record } });
      else this.issue(file, 'invalid_record', 'Expected an object', record);
    };
    if (file.endsWith('.jsonl')) {
      text.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        try { accept(JSON.parse(line), index + 1); }
        catch (error) { this.issue(file, 'invalid_json', (error as Error).message, index + 1); }
      });
    } else {
      try {
        const value: unknown = JSON.parse(text);
        if (Array.isArray(value)) value.forEach((row, index) => accept(row, index + 1));
        else this.issue(file, 'invalid_manifest', 'Expected a top-level array');
      } catch (error) { this.issue(file, 'invalid_json', (error as Error).message); }
    }
    if (!result.length) this.issue(file, 'empty_manifest', 'No valid records');
    return result;
  }

  require(row: RecordData, fields: string[], reference: RecordReference): boolean {
    const missing = fields.filter(key => !string(row[key]));
    if (missing.length) this.issue(reference.file, 'invalid_record', `Missing/non-string fields: ${missing.join(', ')}`, reference.record);
    return missing.length === 0;
  }

  async add(candidate: Candidate): Promise<CatalogueEntry> {
    const { family, reference, record, title } = candidate;
    const path = candidate.path;
    const entry: CatalogueEntry = {
      id: `catalog-${digest(JSON.stringify([family, reference.file, reference.record, path ?? null, title])).slice(0, 32)}`,
      family, reference, title, category: candidate.category ?? 'ready', reason: candidate.reason ?? 'available_extracted_text',
      selected: false, provenance: record, ...(path ? { path } : {}),
    };
    this.entries.push(entry);
    if (!path) {
      if (entry.category === 'ready') { entry.category = 'missing'; entry.reason = 'no_extracted_path'; }
      return entry;
    }
    // Reject unsafe paths before exposing them to the intake consumer.
    try { await this.safePath(path); }
    catch (error) {
      entry.category = 'error'; entry.reason = 'unsafe_path';
      this.issue(reference.file, 'unsafe_path', (error as Error).message, reference.record);
      return entry;
    }
    const source: IntakeSource = {
      path, title, type: candidate.type, quality: candidate.quality, status: 'ready', ...sourceDate(title, record),
      ...(candidate.origin ? { origin: candidate.origin } : {}),
    };
    entry.source = source;
    const isQuarantine = entry.category === 'quarantined' || quarantined(record.status) || quarantined(record.transcript_status) || path.startsWith('collection/transcripts/quarantine/');
    try {
      // Original binaries can be large; inventory existence without loading them into memory.
      if (entry.category === 'unsupported' && !['.txt', '.md', '.srt', '.str', '.vtt'].includes(extname(path).toLowerCase())) {
        const info = await stat(await this.safePath(path));
        if (!info.isFile()) throw new Error('Expected a regular file');
        if (isQuarantine) { entry.category = 'quarantined'; entry.reason = 'quarantine_do_not_use'; }
        source.status = isQuarantine ? 'quarantined' : 'unsupported';
        return entry;
      }
      const data = await this.read(path);
      entry.contentHash = digest(data);
      if (candidate.expectedHash && entry.contentHash !== candidate.expectedHash) {
        entry.category = 'error'; entry.reason = 'manifest_hash_mismatch';
        this.issue(reference.file, 'hash_mismatch', path, reference.record);
      } else if (entry.category === 'ready') {
        if (!['.txt', '.md', '.srt', '.str', '.vtt'].includes(extname(path).toLowerCase())) {
          entry.category = 'unsupported'; entry.reason = 'text_or_subtitle_extraction_required';
        } else {
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
          if (!text.trim()) { entry.category = 'empty'; entry.reason = 'empty_text'; }
          else if (!text.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n').trim()) {
            entry.category = 'excluded'; entry.reason = 'heading_only_text';
          }
        }
      }
    } catch (error) {
      entry.category = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error';
      entry.reason = entry.category === 'missing' ? 'file_missing' : 'read_or_utf8_error';
      if (entry.category === 'error') this.issue(reference.file, entry.reason, `${path}: ${(error as Error).message}`, reference.record);
    }
    if (isQuarantine) { entry.category = 'quarantined'; entry.reason = 'quarantine_do_not_use'; }
    source.status = entry.category === 'ready' ? 'ready' : entry.category === 'metadata_only' ? 'metadata_only'
      : entry.category === 'unsupported' ? 'unsupported' : 'quarantined';
    return entry;
  }

  async metadata(file: string, family: string): Promise<void> {
    await this.add({ family, reference: { file, record: 0 }, record: { role: 'metadata_asset' }, path: file,
      title: basename(file), type: 'metadata', quality: 'collection_metadata_not_evidence', category: 'metadata_only', reason: 'metadata_asset' });
  }

  relate(from: CatalogueEntry, to: string, kind: CatalogueRelationship['kind'], basis: string): void {
    this.relationships.push({ from: from.id, to, kind, verified: false, basis });
  }
}
