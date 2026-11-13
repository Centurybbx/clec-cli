import { deriveAnswerability, NO_HITS_TEXT, referencedIds, renderAnswer, validateBlocks } from '../domain/answer.js';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Citation } from '../domain/contracts.js';
import type { PiSessionReference, ValidatedAnswer } from './types.js';

export class SessionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function requireValue(condition: unknown, code = 'INVALID_ARGUMENT', message = 'Invalid session operation.'): asserts condition {
  if (!condition) throw new SessionError(code, message);
}
export function identifier(value: string): void {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value));
}
export function nonempty(value: string): void {
  requireValue(typeof value === 'string' && value.trim().length > 0);
}
export function duration(value: number): void {
  requireValue(Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647);
}
export function piReference(reference: PiSessionReference, directory: string): PiSessionReference {
  identifier(reference.id);
  nonempty(reference.file);
  // The Pi service creates the file first. Resolve symlinks before accepting association.
  let file: string;
  try { file = realpathSync(resolve(reference.file)); }
  catch { throw new SessionError('INVALID_PI_SESSION', 'Pi session file is unavailable.'); }
  const local = relative(directory, file);
  requireValue(local.length > 0 && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`),
    'INVALID_PI_SESSION', 'Pi session file must be inside the configured Pi directory.');
  return { id: reference.id, file };
}
export function citation(value: Citation, generation: string): void {
  requireValue(value !== null && typeof value === 'object', 'INVALID_EVIDENCE');
  for (const field of ['id', 'generation', 'sourceId', 'sourceVersion', 'sectionId', 'title', 'path', 'quality'] as const) nonempty(value[field]);
  requireValue(value.generation === generation && /^C[1-9][0-9]*$/.test(value.id), 'INVALID_EVIDENCE');
  requireValue(Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end > value.start,
    'INVALID_EVIDENCE');
  requireValue(typeof value.quote === 'string' && value.quote.length === value.end - value.start, 'INVALID_EVIDENCE');
  requireValue(value.date === undefined || typeof value.date === 'string', 'INVALID_EVIDENCE');
  requireValue(value.dateBasis === undefined || typeof value.dateBasis === 'string', 'INVALID_EVIDENCE');
}
export function sameCitation(a: Citation, b: Citation): boolean {
  return a.id === b.id && a.generation === b.generation && a.sourceId === b.sourceId &&
    a.sourceVersion === b.sourceVersion && a.sectionId === b.sectionId && a.start === b.start &&
    a.end === b.end && a.quote === b.quote && a.title === b.title && a.path === b.path &&
    a.quality === b.quality && a.date === b.date && a.dateBasis === b.dateBasis;
}
export function answer(value: ValidatedAnswer, generation: string | null, reads: Citation[]): void {
  requireValue(value?.validated === true && generation !== null, 'INVALID_ANSWER');
  nonempty(value.text);
  requireValue(Array.isArray(value.blocks) && Array.isArray(value.citations), 'INVALID_ANSWER');
  requireValue(value.metrics !== null && typeof value.metrics === 'object' && !Array.isArray(value.metrics), 'INVALID_ANSWER');
  requireValue(Object.values(value.metrics).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0), 'INVALID_ANSWER');
  const ids = new Set<string>();
  for (const item of value.citations) {
    citation(item, generation);
    requireValue(!ids.has(item.id) && reads.some(read => sameCitation(read, item)), 'INVALID_ANSWER');
    ids.add(item.id);
  }
  if (value.answerability === 'no_hits') {
    requireValue(value.blocks.length === 0 && value.text === NO_HITS_TEXT && ids.size === 0 && reads.length === 0, 'INVALID_ANSWER');
    requireValue(value.metrics.modelCalls === 0 && value.metrics.modelRequestAttempts === 0 && value.metrics.contextAdmissionUnits === 0 && value.metrics.usageReports === 0 &&
      value.metrics.readAttempts === 0 && value.metrics.readCalls === 0 && value.metrics.readCharacters === 0 && value.metrics.searchResults === 0 &&
      value.metrics.searches === 1 && value.metrics.searchAttempts === 1, 'INVALID_ANSWER');
    return;
  }
  try {
    const blocks = validateBlocks(value.blocks, ids);
    requireValue(value.answerability === deriveAnswerability(blocks), 'INVALID_ANSWER');
    const used = referencedIds(blocks);
    requireValue(used.length === value.citations.length && used.every((id, index) => id === value.citations[index]?.id), 'INVALID_ANSWER');
    requireValue(value.text === renderAnswer(blocks, value.citations), 'INVALID_ANSWER');
  } catch { throw new SessionError('INVALID_ANSWER', 'Answer did not satisfy the structured result contract.'); }
}
