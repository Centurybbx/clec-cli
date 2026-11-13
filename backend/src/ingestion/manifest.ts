import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { IntakeManifest, IntakeSource, SourceType, IntakeStatus } from '../domain/contracts.js';
import { ClecError } from '../domain/errors.js';
import { validDate } from '../domain/date.js';
const TYPES = new Set<SourceType>(['document', 'qa', 'transcript', 'curated', 'metadata']);
const STATUSES = new Set<IntakeStatus>(['ready', 'quarantined', 'unsupported', 'metadata_only']);
export async function loadManifest(path: string, raw?: string): Promise<IntakeManifest> {
  const value: unknown = JSON.parse(raw ?? await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('sources' in value) || !Array.isArray(value.sources)) {
    throw new ClecError('INVALID_MANIFEST', 'Expected intake schemaVersion 1 with a sources array.');
  }
  const seen = new Set<string>();
  const sources: IntakeSource[] = value.sources.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new ClecError('INVALID_MANIFEST', 'Invalid source entry.');
    const s = entry as Record<string, unknown>;
    for (const key of ['path', 'title', 'type', 'quality', 'status']) {
      if (typeof s[key] !== 'string' || !String(s[key]).trim()) throw new ClecError('INVALID_MANIFEST', `Every source needs a nonempty ${key}.`);
    }
    if (!TYPES.has(s.type as SourceType) || !STATUSES.has(s.status as IntakeStatus)) throw new ClecError('INVALID_MANIFEST', 'Unknown source type or status.');
    const sourcePath = String(s.path).replaceAll('\\', '/');
    if (isAbsolute(sourcePath) || sourcePath.split('/').some(p => p === '..' || p === '.')) throw new ClecError('INVALID_MANIFEST', 'Source paths must be normalized workspace-relative paths.');
    if (seen.has(sourcePath)) throw new ClecError('INVALID_MANIFEST', 'Duplicate source path; reconcile manifest entries before building.');
    seen.add(sourcePath);
    for (const key of ['date', 'dateBasis', 'origin']) if (s[key] !== undefined && typeof s[key] !== 'string') throw new ClecError('INVALID_MANIFEST', 'Optional metadata must be strings.');
    if (s.date !== undefined && (!validDate(String(s.date)) || !s.dateBasis)) throw new ClecError('INVALID_MANIFEST', 'Dates need a real YYYY-MM-DD and an explicit dateBasis.');
    return { path: sourcePath, title: String(s.title), type: s.type as SourceType, quality: String(s.quality), status: s.status as IntakeStatus,
      ...(s.date === undefined ? {} : { date: String(s.date) }), ...(s.dateBasis === undefined ? {} : { dateBasis: String(s.dateBasis) }), ...(s.origin === undefined ? {} : { origin: String(s.origin) }) };
  });
  return { schemaVersion: 1, sources: sources.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}
export async function insideWorkspace(workspace: string, path: string): Promise<string> {
  const root = await realpath(workspace);
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ClecError('UNSAFE_PATH', 'Source resolved outside the workspace.');
  return target;
}
